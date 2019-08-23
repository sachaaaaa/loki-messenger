/* global textsecure: false */
/* global libsignal: false */
/* global window: false */
/* global ConversationController: false */
/* global libloki: false */
/* global StringView: false */
/* global dcodeIO: false */
/* global log: false */
/* global lokiMessageAPI: false */

/* eslint-disable more/no-then */
/* eslint-disable no-unreachable */
const NUM_SEND_CONNECTIONS = 3;

function OutgoingMessage(
  server,
  timestamp,
  numbers,
  message,
  silent,
  callback,
  options = {}
) {
  if (message instanceof textsecure.protobuf.DataMessage) {
    const content = new textsecure.protobuf.Content();
    content.dataMessage = message;
    // eslint-disable-next-line no-param-reassign
    message = content;
  }
  this.server = server;
  this.timestamp = timestamp;
  this.numbers = numbers;
  this.message = message; // ContentMessage proto
  this.callback = callback;
  this.silent = silent;

  this.numbersCompleted = 0;
  this.errors = [];
  this.successfulNumbers = [];
  this.fallBackEncryption = false;
  this.failoverNumbers = [];
  this.unidentifiedDeliveries = [];

  const { numberInfo, senderCertificate, online, messageType, isPing } =
    options || {};
  this.numberInfo = numberInfo;
  this.senderCertificate = senderCertificate;
  this.online = online;
  this.messageType = messageType || 'outgoing';
  this.isPing = isPing || false;
}

OutgoingMessage.prototype = {
  constructor: OutgoingMessage,
  numberCompleted() {
    this.numbersCompleted += 1;
    if (this.numbersCompleted >= this.numbers.length) {
      this.callback({
        successfulNumbers: this.successfulNumbers,
        failoverNumbers: this.failoverNumbers,
        errors: this.errors,
        unidentifiedDeliveries: this.unidentifiedDeliveries,
        messageType: this.messageType,
      });
    }
  },
  registerError(number, reason, error) {
    if (!error || (error.name === 'HTTPError' && error.code !== 404)) {
      // eslint-disable-next-line no-param-reassign
      error = new textsecure.OutgoingMessageError(
        number,
        this.message.toArrayBuffer(),
        this.timestamp,
        error
      );
    }

    // eslint-disable-next-line no-param-reassign
    error.number = number;
    // eslint-disable-next-line no-param-reassign
    error.reason = reason;
    this.errors[this.errors.length] = error;
    this.numberCompleted();
  },
  reloadDevicesAndSend(number, recurse) {
    return () =>
      libloki.storage
        .getAllDevicePubKeysForPrimaryPubKey(number)
        .then(devicesPubKeys => {
          if (devicesPubKeys.length === 0) {
            // eslint-disable-next-line no-param-reassign
            devicesPubKeys = [number];
            // return this.registerError(
            //   number,
            //   'Got empty device list when loading device keys',
            //   null
            // );
          }
          return this.doSendMessage(number, devicesPubKeys, recurse);
        });
  },

  getKeysForNumber(number, updateDevices) {
    const handleResult = response =>
      Promise.all(
        response.devices.map(device => {
          // eslint-disable-next-line no-param-reassign
          device.identityKey = response.identityKey;
          if (
            updateDevices === undefined ||
            updateDevices.indexOf(device.deviceId) > -1
          ) {
            const address = new libsignal.SignalProtocolAddress(
              number,
              device.deviceId
            );
            const builder = new libsignal.SessionBuilder(
              textsecure.storage.protocol,
              address
            );
            if (device.registrationId === 0) {
              window.log.info('device registrationId 0!');
            }
            return builder
              .processPreKey(device)
              .then(async () => {
                // TODO: only remove the keys that were used above!
                await libloki.storage.removeContactPreKeyBundle(number);
                return true;
              })
              .catch(error => {
                if (error.message === 'Identity key changed') {
                  // eslint-disable-next-line no-param-reassign
                  error.timestamp = this.timestamp;
                  // eslint-disable-next-line no-param-reassign
                  error.originalMessage = this.message.toArrayBuffer();
                  // eslint-disable-next-line no-param-reassign
                  error.identityKey = device.identityKey;
                }
                throw error;
              });
          }

          return false;
        })
      );
    // TODO: check if still applicable
    // if (updateDevices === undefined) {
    //   return this.server.getKeysForNumber(number, '*').then(handleResult);
    // }
    let promise = Promise.resolve(true);
    updateDevices.forEach(device => {
      promise = promise.then(() =>
        Promise.all([
          textsecure.storage.protocol.loadContactPreKey(number),
          textsecure.storage.protocol.loadContactSignedPreKey(number),
        ])
          .then(keys => {
            const [preKey, signedPreKey] = keys;
            if (preKey === undefined || signedPreKey === undefined) {
              return false;
            }
            const identityKey = StringView.hexToArrayBuffer(number);
            return handleResult({
              identityKey,
              devices: [
                { deviceId: device, preKey, signedPreKey, registrationId: 0 },
              ],
            }).then(results => results.every(value => value === true));
          })
          .catch(e => {
            if (e.name === 'HTTPError' && e.code === 404) {
              if (device !== 1) {
                return this.removeDeviceIdsForNumber(number, [device]);
              }
              throw new textsecure.UnregisteredUserError(number, e);
            } else {
              throw e;
            }
          })
      );
    });

    return promise;
  },

  // Default ttl to 24 hours if no value provided
  async transmitMessage(number, data, timestamp, ttl = 24 * 60 * 60 * 1000) {
    const pubKey = number;
    try {
      // TODO: Make NUM_CONCURRENT_CONNECTIONS a global constant
      const options = {
        numConnections: NUM_SEND_CONNECTIONS,
        isPing: this.isPing,
      };
      await lokiMessageAPI.sendMessage(pubKey, data, timestamp, ttl, options);
    } catch (e) {
      if (e.name === 'HTTPError' && (e.code !== 409 && e.code !== 410)) {
        // 409 and 410 should bubble and be handled by doSendMessage
        // 404 should throw UnregisteredUserError
        // all other network errors can be retried later.
        if (e.code === 404) {
          throw new textsecure.UnregisteredUserError(number, e);
        }
        throw new textsecure.SendMessageNetworkError(number, '', e, timestamp);
      } else if (e.name === 'TimedOutError') {
        throw new textsecure.PoWError(number, e);
      }
      throw e;
    }
  },

  getPaddedMessageLength(messageLength) {
    const messageLengthWithTerminator = messageLength + 1;
    let messagePartCount = Math.floor(messageLengthWithTerminator / 160);

    if (messageLengthWithTerminator % 160 !== 0) {
      messagePartCount += 1;
    }

    return messagePartCount * 160;
  },
  convertMessageToText(message) {
    const messageBuffer = message.toArrayBuffer();
    const plaintext = new Uint8Array(
      this.getPaddedMessageLength(messageBuffer.byteLength + 1) - 1
    );
    plaintext.set(new Uint8Array(messageBuffer));
    plaintext[messageBuffer.byteLength] = 0x80;

    return plaintext;
  },
  getPlaintext() {
    if (!this.plaintext) {
      this.plaintext = this.convertMessageToText(this.message);
    }
    return this.plaintext;
  },
  async wrapInWebsocketMessage(outgoingObject) {
    const messageEnvelope = new textsecure.protobuf.Envelope({
      type: outgoingObject.type,
      source: outgoingObject.ourKey,
      sourceDevice: outgoingObject.sourceDevice,
      timestamp: this.timestamp,
      content: outgoingObject.content,
    });
    const requestMessage = new textsecure.protobuf.WebSocketRequestMessage({
      id: new Uint8Array(libsignal.crypto.getRandomBytes(1))[0], // random ID for now
      verb: 'PUT',
      path: '/api/v1/message',
      body: messageEnvelope.encode().toArrayBuffer(),
    });
    const websocketMessage = new textsecure.protobuf.WebSocketMessage({
      type: textsecure.protobuf.WebSocketMessage.Type.REQUEST,
      request: requestMessage,
    });
    const bytes = new Uint8Array(websocketMessage.encode().toArrayBuffer());
    return bytes;
  },
  async doSendMessage(number, devicesPubKeys, recurse) {
    const ciphers = {};

    this.numbers = devicesPubKeys;

    /* Disabled because i'm not sure how senderCertificate works :thinking:
    const { numberInfo, senderCertificate } = this;
    const info = numberInfo && numberInfo[number] ? numberInfo[number] : {};
    const { accessKey } = info || {};

    if (accessKey && !senderCertificate) {
      return Promise.reject(
        new Error(
          'OutgoingMessage.doSendMessage: accessKey was provided, ' +
          'but senderCertificate was not'
        )
      );
    }

    const sealedSender = Boolean(accessKey && senderCertificate);

    // We don't send to ourselves if unless sealedSender is enabled
    const ourNumber = textsecure.storage.user.getNumber();
    const ourDeviceId = textsecure.storage.user.getDeviceId();
    if (number === ourNumber && !sealedSender) {
      // eslint-disable-next-line no-param-reassign
      deviceIds = _.reject(
        deviceIds,
        deviceId =>
          // because we store our own device ID as a string at least sometimes
          deviceId === ourDeviceId || deviceId === parseInt(ourDeviceId, 10)
      );
    }
    */

    return Promise.all(
      devicesPubKeys.map(async devicePubKey => {
        // Loki Messenger doesn't use the deviceId scheme, it's always 1.
        // Instead, there are multiple device public keys.
        const deviceId = 1;
        const address = new libsignal.SignalProtocolAddress(
          devicePubKey,
          deviceId
        );
        const ourKey = textsecure.storage.user.getNumber();
        const options = {};
        const fallBackCipher = new libloki.crypto.FallBackSessionCipher(
          address
        );

        // Check if we need to attach the preKeys
        let sessionCipher;
        const isFriendRequest = this.messageType === 'friend-request';
        const isSecondaryDevice = !!window.storage.get('isSecondaryDevice');
        if (isFriendRequest && isSecondaryDevice) {
          // Attach authorisation from primary device ONLY FOR FRIEND REQUEST
          const ourPubKeyHex = textsecure.storage.user.getNumber();
          let pairingAuthorisation = await libloki.storage.getGrantAuthorisationForSecondaryPubKey(
            ourPubKeyHex
          );
          pairingAuthorisation = {
            ...pairingAuthorisation,
            type: textsecure.protobuf.PairingAuthorisationMessage.Type.GRANT,
          };
          if (pairingAuthorisation) {
            this.message.pairingAuthorisation = libloki.api.createPairingAuthorisationProtoMessage(
              pairingAuthorisation
            );
          } else {
            window.log.error(
              'Could not find authorisation for our own pubkey while being secondary device.'
            );
          }
        }
        this.fallBackEncryption = this.fallBackEncryption || isFriendRequest;
        const flags = this.message.dataMessage
          ? this.message.dataMessage.get_flags()
          : null;
        const isEndSession =
          flags === textsecure.protobuf.DataMessage.Flags.END_SESSION;
        if (this.fallBackEncryption || isEndSession) {
          // Encrypt them with the fallback
          const pkb = await libloki.storage.getPreKeyBundleForContact(number);
          const preKeyBundleMessage = new textsecure.protobuf.PreKeyBundleMessage(
            pkb
          );
          this.message.preKeyBundleMessage = preKeyBundleMessage;
          window.log.info('attaching prekeys to outgoing message');
        }
        if (this.fallBackEncryption) {
          sessionCipher = fallBackCipher;
        } else {
          sessionCipher = new libsignal.SessionCipher(
            textsecure.storage.protocol,
            address,
            options
          );
        }
        const plaintext = this.getPlaintext();

        // No limit on message keys if we're communicating with our other devices
        if (ourKey === number) {
          options.messageKeysLimit = false;
        }

        ciphers[address.getDeviceId()] = sessionCipher;

        // Encrypt our plain text
        const ciphertext = await sessionCipher.encrypt(plaintext);
        if (!this.fallBackEncryption) {
          // eslint-disable-next-line no-param-reassign
          ciphertext.body = new Uint8Array(
            dcodeIO.ByteBuffer.wrap(ciphertext.body, 'binary').toArrayBuffer()
          );
        }
        let ttl;
        if (this.messageType === 'friend-request') {
          ttl = 4 * 24 * 60 * 60 * 1000; // 4 days for friend request message
        } else if (this.messageType === 'onlineBroadcast') {
          ttl = 60 * 1000; // 1 minute for online broadcast message
        } else if (this.messageType === 'typing') {
          ttl = 60 * 1000; // 1 minute for typing indicators
        } else {
          const hours = window.getMessageTTL() || 24; // 1 day default for any other message
          ttl = hours * 60 * 60 * 1000;
        }

        return {
          type: ciphertext.type, // FallBackSessionCipher sets this to FRIEND_REQUEST
          ttl,
          ourKey,
          sourceDevice: 1,
          destinationRegistrationId: ciphertext.registrationId,
          content: ciphertext.body,
          number: devicePubKey,
        };
      })
    )
      .then(async outgoingObjects => {
        // TODO: handle multiple devices/messages per transmit
        let counter = 0;
        const promises = outgoingObjects.map(async outgoingObject => {
          const destination = outgoingObject.number;
          try {
            counter += 1;
            if (counter > 1) {
              throw new Error(`Error for device ${counter}`);
            }
            const socketMessage = await this.wrapInWebsocketMessage(
              outgoingObject
            );
            await this.transmitMessage(
              destination,
              socketMessage,
              this.timestamp,
              outgoingObject.ttl
            );
            this.successfulNumbers.push(destination);
          } catch (e) {
            e.number = destination;
            this.errors.push(e);
          }
        });
        await Promise.all(promises);
        // TODO: the retrySend should only send to the devices
        // for which the transmission failed.

        // ensure numberCompleted() will execute the callback
        this.numbersCompleted +=
          this.errors.length + this.successfulNumbers.length;
        // Absorb errors if message sent to at least 1 device
        if (this.successfulNumbers.length > 0) {
          this.errors = [];
        }
        this.numberCompleted();
      })
      .catch(error => {
        // TODO(loki): handle http errors properly
        // - retry later if 400
        // - ignore if 409 (conflict) means the hash already exists
        throw error;
        if (
          error instanceof Error &&
          error.name === 'HTTPError' &&
          (error.code === 410 || error.code === 409)
        ) {
          if (!recurse) {
            return this.registerError(
              number,
              'Hit retry limit attempting to reload device list',
              error
            );
          }

          let p;
          if (error.code === 409) {
            p = this.removeDeviceIdsForNumber(
              number,
              error.response.extraDevices
            );
          } else {
            p = Promise.all(
              error.response.staleDevices.map(deviceId =>
                ciphers[deviceId].closeOpenSessionForDevice(
                  new libsignal.SignalProtocolAddress(number, deviceId)
                )
              )
            );
          }

          return p.then(() => {
            const resetDevices =
              error.code === 410
                ? error.response.staleDevices
                : error.response.missingDevices;
            return this.getKeysForNumber(number, resetDevices).then(
              // We continue to retry as long as the error code was 409; the assumption is
              //   that we'll request new device info and the next request will succeed.
              this.reloadDevicesAndSend(number, error.code === 409)
            );
          });
        } else if (error.message === 'Identity key changed') {
          // eslint-disable-next-line no-param-reassign
          error.timestamp = this.timestamp;
          // eslint-disable-next-line no-param-reassign
          error.originalMessage = this.message.toArrayBuffer();
          window.log.error(
            'Got "key changed" error from encrypt - no identityKey for application layer',
            number,
            devicesPubKeys
          );
          throw error;
        } else {
          this.registerError(number, 'Failed to create or send message', error);
        }

        return null;
      });
  },

  getStaleDeviceIdsForNumber(number) {
    return textsecure.storage.protocol.getDeviceIds(number).then(deviceIds => {
      if (deviceIds.length === 0) {
        return [1];
      }
      const updateDevices = [];
      return Promise.all(
        deviceIds.map(deviceId => {
          const address = new libsignal.SignalProtocolAddress(number, deviceId);
          const sessionCipher = new libsignal.SessionCipher(
            textsecure.storage.protocol,
            address
          );
          return sessionCipher.hasOpenSession().then(hasSession => {
            if (!hasSession) {
              updateDevices.push(deviceId);
            }
          });
        })
      ).then(() => updateDevices);
    });
  },

  removeDeviceIdsForNumber(number, deviceIdsToRemove) {
    let promise = Promise.resolve();
    // eslint-disable-next-line no-restricted-syntax, guard-for-in
    for (const j in deviceIdsToRemove) {
      promise = promise.then(() => {
        const encodedNumber = `${number}.${deviceIdsToRemove[j]}`;
        return textsecure.storage.protocol.removeSession(encodedNumber);
      });
    }
    return promise;
  },

  sendToNumber(number) {
    let conversation;
    try {
      conversation = ConversationController.get(number);
    } catch (e) {
      // do nothing
    }

    return this.getStaleDeviceIdsForNumber(number).then(updateDevices =>
      this.getKeysForNumber(number, updateDevices)
        .then(async keysFound => {
          if (!keysFound) {
            log.info('Fallback encryption enabled');
            this.fallBackEncryption = true;
          }
        })
        .then(this.reloadDevicesAndSend(number, true))
        .catch(error => {
          conversation.resetPendingSend();
          if (error.message === 'Identity key changed') {
            // eslint-disable-next-line no-param-reassign
            error = new textsecure.OutgoingIdentityKeyError(
              number,
              error.originalMessage,
              error.timestamp,
              error.identityKey
            );
            this.registerError(number, 'Identity key changed', error);
          } else {
            this.registerError(
              number,
              `Failed to retrieve new device keys for number ${number}`,
              error
            );
          }
        })
    );
  },
};

window.textsecure = window.textsecure || {};
window.textsecure.OutgoingMessage = OutgoingMessage;
