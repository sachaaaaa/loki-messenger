/* global window: false */
/* global callWorker: false */
/* global textsecure: false */
/* global StringView: false */
/* global libloki: false */
/* global libsignal: false */
/* global WebSocket: false */
/* global Event: false */
/* global dcodeIO: false */
/* global _: false */
/* global HttpResource: false */
/* global ContactBuffer: false */
/* global GroupBuffer: false */
/* global WebSocketResource: false */
/* global localLokiServer: false */
/* global localServerPort: false */
/* global lokiMessageAPI: false */
/* global lokiP2pAPI: false */
/* global Whisper: false */

/* eslint-disable more/no-then */
/* eslint-disable no-unreachable */

function MessageReceiver(username, password, signalingKey, options = {}) {
  this.count = 0;

  this.signalingKey = signalingKey;
  this.username = username;
  this.password = password;

  if (!options.serverTrustRoot) {
    throw new Error('Server trust root is required!');
  }
  this.serverTrustRoot = window.Signal.Crypto.base64ToArrayBuffer(
    options.serverTrustRoot
  );

  const address = libsignal.SignalProtocolAddress.fromString(username);
  this.number = address.getName();
  this.deviceId = address.getDeviceId();

  this.pending = Promise.resolve();

  if (options.retryCached) {
    this.pending = this.queueAllCached();
  }
}

MessageReceiver.stringToArrayBuffer = string =>
  Promise.resolve(dcodeIO.ByteBuffer.wrap(string, 'binary').toArrayBuffer());
MessageReceiver.arrayBufferToString = arrayBuffer =>
  Promise.resolve(dcodeIO.ByteBuffer.wrap(arrayBuffer).toString('binary'));

MessageReceiver.stringToArrayBufferBase64 = string =>
  callWorker('stringToArrayBufferBase64', string);
MessageReceiver.arrayBufferToStringBase64 = arrayBuffer =>
  callWorker('arrayBufferToStringBase64', arrayBuffer);

MessageReceiver.prototype = new textsecure.EventTarget();
MessageReceiver.prototype.extend({
  constructor: MessageReceiver,
  connect() {
    if (this.calledClose) {
      return;
    }

    this.count = 0;
    if (this.hasConnected) {
      const ev = new Event('reconnect');
      this.dispatchEvent(ev);
    }

    this.hasConnected = true;
    this.httpPollingResource = new HttpResource(lokiMessageAPI, {
      handleRequest: this.handleRequest.bind(this),
    });
    this.httpPollingResource.pollServer();
    localLokiServer.on('message', this.handleP2pMessage.bind(this));
    this.startLocalServer();

    // TODO: Rework this socket stuff to work with online messaging
    const useWebSocket = false;
    if (useWebSocket) {
      if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
        this.socket.close();
        this.wsr.close();
      }
      // initialize the socket and start listening for messages
      this.socket = this.server.getMessageSocket();
      this.socket.onclose = this.onclose.bind(this);
      this.socket.onerror = this.onerror.bind(this);
      this.socket.onopen = this.onopen.bind(this);
      this.wsr = new WebSocketResource(this.socket, {
        handleRequest: this.handleRequest.bind(this),
        keepalive: {
          path: '/v1/keepalive',
          disconnect: true,
        },
      });

      // Because sometimes the socket doesn't properly emit its close event
      this._onClose = this.onclose.bind(this);
      this.wsr.addEventListener('close', this._onClose);
    }

    // Ensures that an immediate 'empty' event from the websocket will fire only after
    //   all cached envelopes are processed.
    this.incoming = [this.pending];
  },
  async startLocalServer() {
    try {
      // clearnet change: getMyLokiIp -> getMyClearIp
      // const myLokiIp = await window.lokiSnodeAPI.getMyLokiIp();
      const myLokiIp = '0.0.0.0';
      const myServerPort = await localLokiServer.start(
        localServerPort,
        myLokiIp
      );
      window.log.info(`Local Server started at ${myLokiIp}:${myServerPort}`);
      libloki.api.broadcastOnlineStatus();
    } catch (e) {
      if (e instanceof textsecure.HolePunchingError) {
        window.log.warn(e.message);
        window.log.warn('Abdandoning starting p2p server.');
        return;
      } else if (e instanceof textsecure.LokiIpError) {
        window.log.warn(
          'Failed to get my loki address to bind server to, will retry in 30 seconds'
        );
      } else {
        window.log.warn(
          'Failed to start local loki server, will retry in 30 seconds'
        );
      }
      setTimeout(this.startLocalServer.bind(this), 30 * 1000);
    }
  },
  handleP2pMessage({ message, onSuccess, onFailure }) {
    const options = {
      isP2p: true,
      onSuccess,
      onFailure,
    };
    this.httpPollingResource.handleMessage(message, options);
  },
  stopProcessing() {
    window.log.info('MessageReceiver: stopProcessing requested');
    this.stoppingProcessing = true;
    return this.close();
  },
  shutdown() {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onopen = null;
      this.socket = null;
    }

    if (this.wsr) {
      this.wsr.removeEventListener('close', this._onClose);
      this.wsr = null;
    }

    if (localLokiServer) {
      localLokiServer.removeListener(
        'message',
        this.handleP2pMessage.bind(this)
      );
    }
  },
  close() {
    window.log.info('MessageReceiver.close()');
    this.calledClose = true;

    // Our WebSocketResource instance will close the socket and emit a 'close' event
    //   if the socket doesn't emit one quickly enough.
    if (this.wsr) {
      this.wsr.close(3000, 'called close');
    }

    if (localLokiServer) {
      localLokiServer.close();
    }

    if (this.httpPollingResource) {
      this.httpPollingResource.close();
    }

    return this.drain();
  },
  onopen() {
    window.log.info('websocket open');
  },
  onerror() {
    window.log.error('websocket error');
  },
  dispatchAndWait(event) {
    const promise = this.appPromise || Promise.resolve();
    const appJobPromise = Promise.all(this.dispatchEvent(event));
    const job = () => appJobPromise;

    this.appPromise = promise.then(job, job);

    return Promise.resolve();
  },
  onclose(ev) {
    window.log.info(
      'websocket closed',
      ev.code,
      ev.reason || '',
      'calledClose:',
      this.calledClose
    );
    // TODO: handle properly
    // this.shutdown();

    // if (this.calledClose) {
    //   return Promise.resolve();
    // }
    // if (ev.code === 3000) {
    //   return Promise.resolve();
    // }
    // if (ev.code === 3001) {
    //   this.onEmpty();
    // }
    // // possible 403 or network issue. Make an request to confirm
    // return this.server
    //   .getDevices(this.number)
    //   .then(this.connect.bind(this)) // No HTTP error? Reconnect
    //   .catch(e => {
    //     const event = new Event('error');
    //     event.error = e;
    //     return this.dispatchAndWait(event);
    //   });
  },
  handleRequest(request, options) {
    const { isP2p, onSuccess, onFailure } = options;
    this.incoming = this.incoming || [];
    const lastPromise = _.last(this.incoming);

    // We do the message decryption here, instead of in the ordered pending queue,
    // to avoid exposing the time it took us to process messages through the time-to-ack.

    if (request.path !== '/api/v1/message') {
      window.log.info('got request', request.verb, request.path);
      request.respond(200, 'OK');

      if (request.verb === 'PUT' && request.path === '/api/v1/queue/empty') {
        this.onEmpty();
      }
      return;
    }

    const promise = Promise.resolve(request.body.toArrayBuffer()) // textsecure.crypto
      .then(plaintext => {
        const envelope = textsecure.protobuf.Envelope.decode(plaintext);
        if (isP2p) {
          lokiP2pAPI.setContactOnline(envelope.source);
        }
        // After this point, decoding errors are not the server's
        //   fault, and we should handle them gracefully and tell the
        //   user they received an invalid message

        if (this.isBlocked(envelope.source)) {
          return request.respond(200, 'OK');
        }

        envelope.id = envelope.serverGuid || window.getGuid();
        envelope.isP2p = isP2p;
        envelope.serverTimestamp = envelope.serverTimestamp
          ? envelope.serverTimestamp.toNumber()
          : null;

        return this.addToCache(envelope, plaintext).then(
          async () => {
            request.respond(200, 'OK');

            // To ensure that we queue in the same order we receive messages
            await lastPromise;
            this.queueEnvelope(envelope, onSuccess, onFailure);
          },
          error => {
            request.respond(500, 'Failed to cache message');
            window.log.error(
              'handleRequest error trying to add message to cache:',
              error && error.stack ? error.stack : error
            );
          }
        );
      })
      .catch(e => {
        request.respond(500, 'Bad encrypted websocket message');
        window.log.error(
          'Error handling incoming message:',
          e && e.stack ? e.stack : e
        );
        const ev = new Event('error');
        ev.error = e;
        return this.dispatchAndWait(ev);
      });

    this.incoming.push(promise);
  },
  addToQueue(task) {
    this.count += 1;
    this.pending = this.pending.then(task, task);

    const { count, pending } = this;

    const cleanup = () => {
      this.updateProgress(count);
      // We want to clear out the promise chain whenever possible because it could
      //   lead to large memory usage over time:
      //   https://github.com/nodejs/node/issues/6673#issuecomment-244331609
      if (this.pending === pending) {
        this.pending = Promise.resolve();
      }
    };

    pending.then(cleanup, cleanup);

    return pending;
  },
  onEmpty() {
    const { incoming } = this;
    this.incoming = [];

    const emitEmpty = () => {
      window.log.info("MessageReceiver: emitting 'empty' event");
      const ev = new Event('empty');
      this.dispatchAndWait(ev);
    };

    const waitForApplication = async () => {
      window.log.info(
        "MessageReceiver: finished processing messages after 'empty', now waiting for application"
      );
      const promise = this.appPromise || Promise.resolve();
      this.appPromise = Promise.resolve();

      // We don't await here because we don't this to gate future message processing
      promise.then(emitEmpty, emitEmpty);
    };

    const waitForEmptyQueue = () => {
      // resetting count to zero so everything queued after this starts over again
      this.count = 0;

      this.addToQueue(waitForApplication);
    };

    // We first wait for all recently-received messages (this.incoming) to be queued,
    //   then we queue a task to wait for the application to finish its processing, then
    //   finally we emit the 'empty' event to the queue.
    Promise.all(incoming).then(waitForEmptyQueue, waitForEmptyQueue);
  },
  drain() {
    const { incoming } = this;
    this.incoming = [];

    const queueDispatch = () =>
      this.addToQueue(() => {
        window.log.info('drained');
      });

    // This promise will resolve when there are no more messages to be processed.
    return Promise.all(incoming).then(queueDispatch, queueDispatch);
  },
  updateProgress(count) {
    // count by 10s
    if (count % 10 !== 0) {
      return;
    }
    const ev = new Event('progress');
    ev.count = count;
    this.dispatchEvent(ev);
  },
  async queueAllCached() {
    const items = await this.getAllFromCache();
    for (let i = 0, max = items.length; i < max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await this.queueCached(items[i]);
    }
  },
  async queueCached(item) {
    try {
      let envelopePlaintext = item.envelope;

      if (item.version === 2) {
        envelopePlaintext = await MessageReceiver.stringToArrayBufferBase64(
          envelopePlaintext
        );
      }

      if (typeof envelopePlaintext === 'string') {
        envelopePlaintext = await MessageReceiver.stringToArrayBuffer(
          envelopePlaintext
        );
      }
      const envelope = textsecure.protobuf.Envelope.decode(envelopePlaintext);
      envelope.id = envelope.serverGuid || item.id;
      envelope.source = envelope.source || item.source;
      envelope.sourceDevice = envelope.sourceDevice || item.sourceDevice;
      envelope.serverTimestamp =
        envelope.serverTimestamp || item.serverTimestamp;
      envelope.preKeyBundleMessage =
        envelope.preKeyBundleMessage || item.preKeyBundleMessage;

      const { decrypted } = item;
      if (decrypted) {
        let payloadPlaintext = decrypted;

        if (item.version === 2) {
          payloadPlaintext = await MessageReceiver.stringToArrayBufferBase64(
            payloadPlaintext
          );
        }

        if (typeof payloadPlaintext === 'string') {
          payloadPlaintext = await MessageReceiver.stringToArrayBuffer(
            payloadPlaintext
          );
        }

        // Convert preKeys to array buffer
        if (typeof envelope.preKeyBundleMessage === 'string') {
          envelope.preKeyBundleMessage = await MessageReceiver.stringToArrayBuffer(
            envelope.preKeyBundleMessage
          );
        }
        this.queueDecryptedEnvelope(envelope, payloadPlaintext);
      } else {
        this.queueEnvelope(envelope);
      }
    } catch (error) {
      window.log.error(
        'queueCached error handling item',
        item.id,
        'removing it. Error:',
        error && error.stack ? error.stack : error
      );

      try {
        const { id } = item;
        await textsecure.storage.unprocessed.remove(id);
      } catch (deleteError) {
        window.log.error(
          'queueCached error deleting item',
          item.id,
          'Error:',
          deleteError && deleteError.stack ? deleteError.stack : deleteError
        );
      }
    }
  },
  getEnvelopeId(envelope) {
    if (envelope.source) {
      return `${envelope.source}.${
        envelope.sourceDevice
      } ${envelope.timestamp.toNumber()} (${envelope.id})`;
    }

    return envelope.id;
  },
  async getAllFromCache() {
    window.log.info('getAllFromCache');
    const count = await textsecure.storage.unprocessed.getCount();

    if (count > 1500) {
      await textsecure.storage.unprocessed.removeAll();
      window.log.warn(
        `There were ${count} messages in cache. Deleted all instead of reprocessing`
      );
      return [];
    }

    const items = await textsecure.storage.unprocessed.getAll();
    window.log.info('getAllFromCache loaded', items.length, 'saved envelopes');

    return Promise.all(
      _.map(items, async item => {
        const attempts = 1 + (item.attempts || 0);

        try {
          if (attempts >= 3) {
            window.log.warn(
              'getAllFromCache final attempt for envelope',
              item.id
            );
            await textsecure.storage.unprocessed.remove(item.id);
          } else {
            await textsecure.storage.unprocessed.updateAttempts(
              item.id,
              attempts
            );
          }
        } catch (error) {
          window.log.error(
            'getAllFromCache error updating item after load:',
            error && error.stack ? error.stack : error
          );
        }

        return item;
      })
    );
  },
  async addToCache(envelope, plaintext) {
    const { id } = envelope;
    const data = {
      id,
      version: 2,
      envelope: await MessageReceiver.arrayBufferToStringBase64(plaintext),
      timestamp: Date.now(),
      attempts: 1,
    };
    return textsecure.storage.unprocessed.add(data);
  },
  async updateCache(envelope, plaintext) {
    const { id } = envelope;
    const item = await textsecure.storage.unprocessed.get(id);
    if (!item) {
      window.log.error(
        `updateCache: Didn't find item ${id} in cache to update`
      );
      return null;
    }

    item.source = envelope.source;
    item.sourceDevice = envelope.sourceDevice;
    item.serverTimestamp = envelope.serverTimestamp;

    if (item.version === 2) {
      item.decrypted = await MessageReceiver.arrayBufferToStringBase64(
        plaintext
      );
    } else {
      item.decrypted = await MessageReceiver.arrayBufferToString(plaintext);
    }

    return textsecure.storage.unprocessed.addDecryptedData(item.id, item);
  },
  removeFromCache(envelope) {
    const { id } = envelope;
    return textsecure.storage.unprocessed.remove(id);
  },
  queueDecryptedEnvelope(envelope, plaintext) {
    const id = this.getEnvelopeId(envelope);
    window.log.info('queueing decrypted envelope', id);

    const task = this.handleDecryptedEnvelope.bind(this, envelope, plaintext);
    const taskWithTimeout = textsecure.createTaskWithTimeout(
      task,
      `queueEncryptedEnvelope ${id}`
    );
    const promise = this.addToQueue(taskWithTimeout);

    return promise.catch(error => {
      window.log.error(
        `queueDecryptedEnvelope error handling envelope ${id}:`,
        error && error.stack ? error.stack : error
      );
    });
  },
  queueEnvelope(envelope, onSuccess = null, onFailure = null) {
    const id = this.getEnvelopeId(envelope);
    window.log.info('queueing envelope', id);

    const task = this.handleEnvelope.bind(this, envelope);
    const taskWithTimeout = textsecure.createTaskWithTimeout(
      task,
      `queueEnvelope ${id}`
    );
    const promise = this.addToQueue(taskWithTimeout);
    promise.then(() => {
      if (onSuccess) {
        onSuccess();
      }
    });

    return promise.catch(error => {
      window.log.error(
        'queueEnvelope error handling envelope',
        id,
        ':',
        error && error.stack ? error.stack : error
      );
      if (onFailure) {
        onFailure();
      }
    });
  },
  // Same as handleEnvelope, just without the decryption step. Necessary for handling
  //   messages which were successfully decrypted, but application logic didn't finish
  //   processing.
  handleDecryptedEnvelope(envelope, plaintext) {
    if (this.stoppingProcessing) {
      return Promise.resolve();
    }
    // No decryption is required for delivery receipts, so the decrypted field of
    //   the Unprocessed model will never be set

    if (envelope.content) {
      return this.innerHandleContentMessage(envelope, plaintext);
    } else if (envelope.legacyMessage) {
      return this.innerHandleLegacyMessage(envelope, plaintext);
    }
    this.removeFromCache(envelope);
    throw new Error('Received message with no content and no legacyMessage');
  },
  handleEnvelope(envelope) {
    if (this.stoppingProcessing) {
      return Promise.resolve();
    }

    if (envelope.type === textsecure.protobuf.Envelope.Type.RECEIPT) {
      return this.onDeliveryReceipt(envelope);
    }

    if (envelope.content) {
      return this.handleContentMessage(envelope);
    }
    if (envelope.legacyMessage) {
      return this.handleLegacyMessage(envelope);
    }
    this.removeFromCache(envelope);
    throw new Error('Received message with no content and no legacyMessage');
  },
  getStatus() {
    if (this.httpPollingResource) {
      return this.httpPollingResource.isConnected()
        ? WebSocket.OPEN
        : WebSocket.CLOSED;
    }
    if (this.socket) {
      return this.socket.readyState;
    } else if (this.hasConnected) {
      return WebSocket.CLOSED;
    }
    return -1;
  },
  onDeliveryReceipt(envelope) {
    return new Promise((resolve, reject) => {
      const ev = new Event('delivery');
      ev.confirm = this.removeFromCache.bind(this, envelope);
      ev.deliveryReceipt = {
        timestamp: envelope.timestamp.toNumber(),
        source: envelope.source,
        sourceDevice: envelope.sourceDevice,
      };
      this.dispatchAndWait(ev).then(resolve, reject);
    });
  },
  unpad(paddedData) {
    const paddedPlaintext = new Uint8Array(paddedData);
    let plaintext;

    for (let i = paddedPlaintext.length - 1; i >= 0; i -= 1) {
      if (paddedPlaintext[i] === 0x80) {
        plaintext = new Uint8Array(i);
        plaintext.set(paddedPlaintext.subarray(0, i));
        plaintext = plaintext.buffer;
        break;
      } else if (paddedPlaintext[i] !== 0x00) {
        throw new Error('Invalid padding');
      }
    }

    return plaintext;
  },
  async decrypt(envelope, ciphertext) {
    const { serverTrustRoot } = this;

    let promise;
    const address = new libsignal.SignalProtocolAddress(
      envelope.source,
      envelope.sourceDevice
    );

    const ourNumber = textsecure.storage.user.getNumber();
    const number = address.toString().split('.')[0];
    const options = {};

    // No limit on message keys if we're communicating with our other devices
    if (ourNumber === number) {
      options.messageKeysLimit = false;
    }

    const sessionCipher = new libsignal.SessionCipher(
      textsecure.storage.protocol,
      address,
      options
    );
    const secretSessionCipher = new window.Signal.Metadata.SecretSessionCipher(
      textsecure.storage.protocol
    );

    const fallBackSessionCipher = new libloki.crypto.FallBackSessionCipher(
      address
    );

    const me = {
      number: ourNumber,
      deviceId: parseInt(textsecure.storage.user.getDeviceId(), 10),
    };

    let conversation;
    try {
      conversation = await window.ConversationController.getOrCreateAndWait(
        envelope.source,
        'private'
      );
    } catch (e) {
      window.log.info('Error getting conversation: ', envelope.source);
    }
    const getCurrentSessionBaseKey = async () => {
      const record = await sessionCipher.getRecord(address.toString());
      if (!record) return null;
      const openSession = record.getOpenSession();
      if (!openSession) return null;
      const { baseKey } = openSession.indexInfo;
      return baseKey;
    };
    const captureActiveSession = async () => {
      this.activeSessionBaseKey = await getCurrentSessionBaseKey(sessionCipher);
    };
    const restoreActiveSession = async () => {
      const record = await sessionCipher.getRecord(address.toString());
      if (!record) return;
      record.archiveCurrentState();
      const sessionToRestore = record.sessions[this.activeSessionBaseKey];
      record.promoteState(sessionToRestore);
      record.updateSessionState(sessionToRestore);
      await textsecure.storage.protocol.storeSession(
        address.toString(),
        record.serialize()
      );
    };
    const deleteAllSessionExcept = async sessionBaseKey => {
      const record = await sessionCipher.getRecord(address.toString());
      if (!record) return;
      const sessionToKeep = record.sessions[sessionBaseKey];
      record.sessions = {};
      record.updateSessionState(sessionToKeep);
      await textsecure.storage.protocol.storeSession(
        address.toString(),
        record.serialize()
      );
    };
    let handleSessionReset;
    if (conversation.isSessionResetOngoing()) {
      handleSessionReset = async result => {
        const currentSessionBaseKey = await getCurrentSessionBaseKey(
          sessionCipher
        );
        if (
          this.activeSessionBaseKey &&
          currentSessionBaseKey !== this.activeSessionBaseKey
        ) {
          if (conversation.isSessionResetReceived()) {
            await restoreActiveSession();
          } else {
            await deleteAllSessionExcept(currentSessionBaseKey);
            await conversation.onNewSessionAdopted();
          }
        } else if (conversation.isSessionResetReceived()) {
          await deleteAllSessionExcept(this.activeSessionBaseKey);
          await conversation.onNewSessionAdopted();
        }
        return result;
      };
    } else {
      handleSessionReset = async result => result;
    }

    switch (envelope.type) {
      case textsecure.protobuf.Envelope.Type.CIPHERTEXT:
        window.log.info('message from', this.getEnvelopeId(envelope));
        promise = captureActiveSession()
          .then(() => sessionCipher.decryptWhisperMessage(ciphertext))
          .then(this.unpad)
          .then(handleSessionReset);
        break;
      case textsecure.protobuf.Envelope.Type.FRIEND_REQUEST: {
        window.log.info('friend-request message from ', envelope.source);
        promise = fallBackSessionCipher
          .decrypt(ciphertext.toArrayBuffer())
          .then(this.unpad);
        break;
      }
      case textsecure.protobuf.Envelope.Type.PREKEY_BUNDLE:
        window.log.info('prekey message from', this.getEnvelopeId(envelope));
        promise = captureActiveSession(sessionCipher)
          .then(async () => {
            if (!this.activeSessionBaseKey) {
              try {
                const buffer = dcodeIO.ByteBuffer.wrap(ciphertext);
                await window.libloki.storage.verifyFriendRequestAcceptPreKey(
                  envelope.source,
                  buffer
                );
              } catch (e) {
                await this.removeFromCache(envelope);
                throw e;
              }
            }
            return this.decryptPreKeyWhisperMessage(
              ciphertext,
              sessionCipher,
              address
            );
          })
          .then(handleSessionReset);
        break;
      case textsecure.protobuf.Envelope.Type.UNIDENTIFIED_SENDER:
        window.log.info('received unidentified sender message');
        promise = secretSessionCipher
          .decrypt(
            window.Signal.Metadata.createCertificateValidator(serverTrustRoot),
            ciphertext.toArrayBuffer(),
            Math.min(envelope.serverTimestamp || Date.now(), Date.now()),
            me
          )
          .then(
            result => {
              const { isMe, sender, content } = result;

              // We need to drop incoming messages from ourself since server can't
              //   do it for us
              if (isMe) {
                return { isMe: true };
              }

              if (this.isBlocked(sender.getName())) {
                window.log.info(
                  'Dropping blocked message after sealed sender decryption'
                );
                return { isBlocked: true };
              }

              // Here we take this sender information and attach it back to the envelope
              //   to make the rest of the app work properly.

              const originalSource = envelope.source;

              // eslint-disable-next-line no-param-reassign
              envelope.source = sender.getName();
              // eslint-disable-next-line no-param-reassign
              envelope.sourceDevice = sender.getDeviceId();
              // eslint-disable-next-line no-param-reassign
              envelope.unidentifiedDeliveryReceived = !originalSource;

              // Return just the content because that matches the signature of the other
              //   decrypt methods used above.
              return this.unpad(content);
            },
            error => {
              const { sender } = error || {};

              if (sender) {
                const originalSource = envelope.source;

                if (this.isBlocked(sender.getName())) {
                  window.log.info(
                    'Dropping blocked message with error after sealed sender decryption'
                  );
                  return { isBlocked: true };
                }

                // eslint-disable-next-line no-param-reassign
                envelope.source = sender.getName();
                // eslint-disable-next-line no-param-reassign
                envelope.sourceDevice = sender.getDeviceId();
                // eslint-disable-next-line no-param-reassign
                envelope.unidentifiedDeliveryReceived = !originalSource;

                throw error;
              }

              return this.removeFromCache(envelope).then(() => {
                throw error;
              });
            }
          );
        break;
      default:
        promise = Promise.reject(new Error('Unknown message type'));
    }

    return promise
      .then(async plaintext => {
        const { isMe, isBlocked } = plaintext || {};
        if (isMe || isBlocked) {
          this.removeFromCache(envelope);
          return null;
        }
        if (
          envelope.type !== textsecure.protobuf.Envelope.Type.FRIEND_REQUEST
        ) {
          // If we got here there is a valid session, which meants friend request
          // is complete (if it wasn't already)
          if (conversation) {
            const isFriendRequestAccept = await conversation.onFriendRequestAccepted();
            if (isFriendRequestAccept) {
              await conversation.notifyFriendRequest(
                envelope.source,
                'accepted'
              );
            }
          }
        }

        this.updateCache(envelope, plaintext).catch(error => {
          window.log.error(
            'decrypt failed to save decrypted message contents to cache:',
            error && error.stack ? error.stack : error
          );
        });

        return plaintext;
      })
      .catch(error => {
        let errorToThrow = error;

        if (error && error.message === 'Unknown identity key') {
          // create an error that the UI will pick up and ask the
          // user if they want to re-negotiate
          const buffer = dcodeIO.ByteBuffer.wrap(ciphertext);
          errorToThrow = new textsecure.IncomingIdentityKeyError(
            address.toString(),
            buffer.toArrayBuffer(),
            error.identityKey
          );
        } else {
          // re-throw
          throw error;
        }
        const ev = new Event('error');
        ev.error = errorToThrow;
        ev.proto = envelope;
        ev.confirm = this.removeFromCache.bind(this, envelope);

        const returnError = () => Promise.reject(errorToThrow);
        return this.dispatchAndWait(ev).then(returnError, returnError);
      });
  },
  async decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address) {
    const padded = await sessionCipher.decryptPreKeyWhisperMessage(ciphertext);

    try {
      return this.unpad(padded);
    } catch (e) {
      if (e.message === 'Unknown identity key') {
        // create an error that the UI will pick up and ask the
        // user if they want to re-negotiate
        const buffer = dcodeIO.ByteBuffer.wrap(ciphertext);
        throw new textsecure.IncomingIdentityKeyError(
          address.toString(),
          buffer.toArrayBuffer(),
          e.identityKey
        );
      }
      throw e;
    }
  },
  handleSentMessage(envelope, sentContainer, msg) {
    const {
      destination,
      timestamp,
      expirationStartTimestamp,
      unidentifiedStatus,
    } = sentContainer;

    let p = Promise.resolve();
    // eslint-disable-next-line no-bitwise
    if (msg.flags & textsecure.protobuf.DataMessage.Flags.END_SESSION) {
      p = this.handleEndSession(destination);
    }
    return p.then(() =>
      this.processDecrypted(envelope, msg).then(message => {
        const groupId = message.group && message.group.id;
        const isBlocked = this.isGroupBlocked(groupId);
        const isMe = envelope.source === textsecure.storage.user.getNumber();
        const isLeavingGroup = Boolean(
          message.group &&
            message.group.type === textsecure.protobuf.GroupContext.Type.QUIT
        );

        if (groupId && isBlocked && !(isMe && isLeavingGroup)) {
          window.log.warn(
            `Message ${this.getEnvelopeId(
              envelope
            )} ignored; destined for blocked group`
          );
          return this.removeFromCache(envelope);
        }

        const ev = new Event('sent');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.data = {
          destination,
          timestamp: timestamp.toNumber(),
          device: envelope.sourceDevice,
          unidentifiedStatus,
          message,
        };
        if (expirationStartTimestamp) {
          ev.data.expirationStartTimestamp = expirationStartTimestamp.toNumber();
        }
        return this.dispatchAndWait(ev);
      })
    );
  },
  async handleLokiAddressMessage(envelope, lokiAddressMessage) {
    const { p2pAddress, p2pPort, type } = lokiAddressMessage;
    if (type === textsecure.protobuf.LokiAddressMessage.Type.HOST_REACHABLE) {
      lokiP2pAPI.updateContactP2pDetails(
        envelope.source,
        p2pAddress,
        p2pPort,
        envelope.isP2p
      );
    }
    return this.removeFromCache(envelope);
  },
  async validateAuthorisation(authorisation) {
    const {
      type,
      primaryDevicePubKey,
      secondaryDevicePubKey,
      requestSignature,
      grantSignature,
    } = authorisation;
    const alreadySecondaryDevice = !!window.storage.get('isSecondaryDevice');
    const ourPubKey = textsecure.storage.user.getNumber();
    const isRequest =
      type === textsecure.protobuf.PairingAuthorisationMessage.Type.REQUEST;
    const isGrant =
      type === textsecure.protobuf.PairingAuthorisationMessage.Type.GRANT;
    if (!primaryDevicePubKey || !secondaryDevicePubKey) {
      window.log.warn(
        'Received a pairing request with missing pubkeys. Ignored.'
      );
      return false;
    } else if (!requestSignature) {
      window.log.warn(
        'Received a pairing request with missing request signature. Ignored.'
      );
      return false;
    } else if (isRequest && alreadySecondaryDevice) {
      window.log.warn(
        'Received a pairing request while being a secondary device. Ignored.'
      );
      return false;
    } else if (isRequest && authorisation.primaryDevicePubKey !== ourPubKey) {
      window.log.warn(
        'Received a pairing request addressed to another pubkey. Ignored.'
      );
      return false;
    } else if (authorisation.secondaryDevicePubKey === ourPubKey) {
      window.log.warn('Received a pairing request from ourselves. Ignored.');
      return false;
    }
    try {
      await libloki.crypto.verifyPairingAuthorisation(
        primaryDevicePubKey,
        secondaryDevicePubKey,
        dcodeIO.ByteBuffer.wrap(requestSignature).toArrayBuffer(),
        type
      );
    } catch (e) {
      window.log.warn(
        'Could not verify pairing request authorisation signature. Ignoring message.'
      );
      window.log.error(e);
      return false;
    }
    if (isGrant) {
      try {
        await libloki.crypto.verifyPairingAuthorisation(
          primaryDevicePubKey,
          secondaryDevicePubKey,
          dcodeIO.ByteBuffer.wrap(grantSignature).toArrayBuffer(),
          type
        );
      } catch (e) {
        window.log.warn(
          'Could not verify pairing grant authorisation signature. Ignoring message.'
        );
        window.log.error(e);
        return false;
      }
    }
    return true;
  },
  async handlePairingRequest(pairingRequest) {
    if (!this.validateAuthorisation(pairingRequest)) {
      return;
    }
    window.libloki.storage.savePairingAuthorisation(pairingRequest);
    Whisper.events.trigger(
      'devicePairingRequestReceived',
      pairingRequest.secondaryDevicePubKey
    );
  },
  async handleAuthorisationForSelf(pairingAuthorisation) {
    if (!this.validateAuthorisation(pairingAuthorisation)) {
      return;
    }
    const { type, primaryDevicePubKey } = pairingAuthorisation;
    if (type === textsecure.protobuf.PairingAuthorisationMessage.Type.GRANT) {
      // Authorisation received to become a secondary device
      window.log.info(
        `Received pairing authorisation from ${primaryDevicePubKey}`
      );
      const alreadySecondaryDevice = window.storage.get('isSecondaryDevice');
      if (alreadySecondaryDevice) {
        window.log.warn(
          'Received an unexpected pairing authorisation (device is already paired as secondary device). Ignoring.'
        );
        return;
      }
      await libloki.storage.savePairingAuthorisation(pairingAuthorisation);
      // Set current device as secondary.
      // This will ensure the authorisation is sent
      // along with each friend request.
      window.storage.remove('secondaryDeviceStatus');
      window.storage.put('isSecondaryDevice', true);
      Whisper.events.trigger('secondaryDeviceRegistration');
    } else {
      window.log.warn('Unimplemented pairing authorisation message type');
    }
  },
  async handleAuthorisationForContact(pairingAuthorisation) {
    if (!this.validateAuthorisation(pairingAuthorisation)) {
      return;
    }
    const { primaryDevicePubKey, secondaryDevicePubKey } = pairingAuthorisation;
    // ensure the primary device is a friend
    const c = window.ConversationController.get(primaryDevicePubKey);
    if (!c || !c.isFriend()) {
      return;
    }
    await libloki.storage.savePairingAuthorisation(pairingAuthorisation);
    // send friend accept?
    window.libloki.api.sendBackgroundMessage(secondaryDevicePubKey);
  },
  async handlePairingAuthorisationMessage(envelope, pairingAuthorisation) {
    const { type, secondaryDevicePubKey } = pairingAuthorisation;
    if (type === textsecure.protobuf.PairingAuthorisationMessage.Type.REQUEST) {
      await this.handlePairingRequest(pairingAuthorisation);
    } else if (secondaryDevicePubKey === textsecure.storage.user.getNumber()) {
      await this.handleAuthorisationForSelf(pairingAuthorisation);
    } else {
      await this.handleAuthorisationForContact(pairingAuthorisation);
    }
    return this.removeFromCache(envelope);
  },
  handleDataMessage(envelope, msg) {
    if (!envelope.isP2p) {
      const timestamp = envelope.timestamp.toNumber();
      const now = Date.now();
      const ageInSeconds = (now - timestamp) / 1000;
      if (ageInSeconds <= 120) {
        lokiP2pAPI.pingContact(envelope.source);
      }
    }
    window.log.info('data message from', this.getEnvelopeId(envelope));
    let p = Promise.resolve();
    // eslint-disable-next-line no-bitwise
    if (msg.flags & textsecure.protobuf.DataMessage.Flags.END_SESSION) {
      p = this.handleEndSession(envelope.source);
    }
    return p.then(() =>
      this.processDecrypted(envelope, msg).then(async message => {
        const groupId = message.group && message.group.id;
        const isBlocked = this.isGroupBlocked(groupId);
        const isMe = envelope.source === textsecure.storage.user.getNumber();
        const conversation = window.ConversationController.get(envelope.source);
        const isLeavingGroup = Boolean(
          message.group &&
            message.group.type === textsecure.protobuf.GroupContext.Type.QUIT
        );
        const friendRequest =
          envelope.type === textsecure.protobuf.Envelope.Type.FRIEND_REQUEST;

        // Check if we need to update any profile names
        if (!isMe && conversation) {
          let profile = null;
          if (message.profile) {
            profile = JSON.parse(message.profile.encodeJSON());
          }

          // Update the conversation
          await conversation.setProfile(profile);
        }

        if (friendRequest && isMe) {
          window.log.info('refusing to add a friend request to ourselves');
          throw new Error('Cannot add a friend request for ourselves!');
        }

        if (groupId && isBlocked && !(isMe && isLeavingGroup)) {
          window.log.warn(
            `Message ${this.getEnvelopeId(
              envelope
            )} ignored; destined for blocked group`
          );
          return this.removeFromCache(envelope);
        }

        const ev = new Event('message');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.data = {
          friendRequest,
          source: envelope.source,
          sourceDevice: envelope.sourceDevice,
          timestamp: envelope.timestamp.toNumber(),
          receivedAt: envelope.receivedAt,
          unidentifiedDeliveryReceived: envelope.unidentifiedDeliveryReceived,
          isP2p: envelope.isP2p,
          message,
        };
        return this.dispatchAndWait(ev);
      })
    );
  },
  handleLegacyMessage(envelope) {
    return this.decrypt(envelope, envelope.legacyMessage).then(plaintext => {
      if (!plaintext) {
        window.log.warn('handleLegacyMessage: plaintext was falsey');
        return null;
      }
      return this.innerHandleLegacyMessage(envelope, plaintext);
    });
  },
  innerHandleLegacyMessage(envelope, plaintext) {
    const message = textsecure.protobuf.DataMessage.decode(plaintext);
    return this.handleDataMessage(envelope, message);
  },
  handleContentMessage(envelope) {
    return this.decrypt(envelope, envelope.content).then(plaintext => {
      if (!plaintext) {
        window.log.warn('handleContentMessage: plaintext was falsey');
        return null;
      } else if (
        plaintext instanceof ArrayBuffer &&
        plaintext.byteLength === 0
      ) {
        return null;
      }
      return this.innerHandleContentMessage(envelope, plaintext);
    });
  },
  async innerHandleContentMessage(envelope, plaintext) {
    const content = textsecure.protobuf.Content.decode(plaintext);

    if (content.preKeyBundleMessage) {
      await this.savePreKeyBundleMessage(
        envelope.source,
        content.preKeyBundleMessage
      );
    }
    if (content.lokiAddressMessage) {
      return this.handleLokiAddressMessage(
        envelope,
        content.lokiAddressMessage
      );
    }
    if (content.pairingAuthorisation) {
      return this.handlePairingAuthorisationMessage(
        envelope,
        content.pairingAuthorisation
      );
    }
    if (content.syncMessage) {
      return this.handleSyncMessage(envelope, content.syncMessage);
    }
    if (content.dataMessage) {
      return this.handleDataMessage(envelope, content.dataMessage);
    }
    if (content.nullMessage) {
      return this.handleNullMessage(envelope, content.nullMessage);
    }
    if (content.callMessage) {
      return this.handleCallMessage(envelope, content.callMessage);
    }
    if (content.receiptMessage) {
      return this.handleReceiptMessage(envelope, content.receiptMessage);
    }
    if (content.typingMessage) {
      return this.handleTypingMessage(envelope, content.typingMessage);
    }

    return null;
  },
  handleCallMessage(envelope) {
    window.log.info('call message from', this.getEnvelopeId(envelope));
    this.removeFromCache(envelope);
  },
  handleReceiptMessage(envelope, receiptMessage) {
    const results = [];
    if (
      receiptMessage.type === textsecure.protobuf.ReceiptMessage.Type.DELIVERY
    ) {
      for (let i = 0; i < receiptMessage.timestamp.length; i += 1) {
        const ev = new Event('delivery');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.deliveryReceipt = {
          timestamp: receiptMessage.timestamp[i].toNumber(),
          source: envelope.source,
          sourceDevice: envelope.sourceDevice,
        };
        results.push(this.dispatchAndWait(ev));
      }
    } else if (
      receiptMessage.type === textsecure.protobuf.ReceiptMessage.Type.READ
    ) {
      for (let i = 0; i < receiptMessage.timestamp.length; i += 1) {
        const ev = new Event('read');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.timestamp = envelope.timestamp.toNumber();
        ev.read = {
          timestamp: receiptMessage.timestamp[i].toNumber(),
          reader: envelope.source,
        };
        results.push(this.dispatchAndWait(ev));
      }
    }
    return Promise.all(results);
  },
  handleTypingMessage(envelope, typingMessage) {
    const ev = new Event('typing');

    this.removeFromCache(envelope);

    if (envelope.timestamp && typingMessage.timestamp) {
      const envelopeTimestamp = envelope.timestamp.toNumber();
      const typingTimestamp = typingMessage.timestamp.toNumber();

      if (typingTimestamp !== envelopeTimestamp) {
        window.log.warn(
          `Typing message envelope timestamp (${envelopeTimestamp}) did not match typing timestamp (${typingTimestamp})`
        );
        return null;
      }
    }

    ev.sender = envelope.source;
    ev.senderDevice = envelope.sourceDevice;
    ev.typing = {
      typingMessage,
      timestamp: typingMessage.timestamp
        ? typingMessage.timestamp.toNumber()
        : Date.now(),
      groupId: typingMessage.groupId
        ? typingMessage.groupId.toString('binary')
        : null,
      started:
        typingMessage.action ===
        textsecure.protobuf.TypingMessage.Action.STARTED,
      stopped:
        typingMessage.action ===
        textsecure.protobuf.TypingMessage.Action.STOPPED,
    };

    return this.dispatchEvent(ev);
  },
  handleNullMessage(envelope) {
    window.log.info('null message from', this.getEnvelopeId(envelope));
    this.removeFromCache(envelope);
  },
  handleSyncMessage(envelope, syncMessage) {
    if (envelope.source !== this.number) {
      throw new Error('Received sync message from another number');
    }
    // eslint-disable-next-line eqeqeq
    if (envelope.sourceDevice == this.deviceId) {
      throw new Error('Received sync message from our own device');
    }
    if (syncMessage.sent) {
      const sentMessage = syncMessage.sent;
      const to = sentMessage.message.group
        ? `group(${sentMessage.message.group.id.toBinary()})`
        : sentMessage.destination;

      window.log.info(
        'sent message to',
        to,
        sentMessage.timestamp.toNumber(),
        'from',
        this.getEnvelopeId(envelope)
      );
      return this.handleSentMessage(envelope, sentMessage, sentMessage.message);
    } else if (syncMessage.contacts) {
      return this.handleContacts(envelope, syncMessage.contacts);
    } else if (syncMessage.groups) {
      return this.handleGroups(envelope, syncMessage.groups);
    } else if (syncMessage.blocked) {
      return this.handleBlocked(envelope, syncMessage.blocked);
    } else if (syncMessage.request) {
      window.log.info('Got SyncMessage Request');
      return this.removeFromCache(envelope);
    } else if (syncMessage.read && syncMessage.read.length) {
      window.log.info('read messages from', this.getEnvelopeId(envelope));
      return this.handleRead(envelope, syncMessage.read);
    } else if (syncMessage.verified) {
      return this.handleVerified(envelope, syncMessage.verified);
    } else if (syncMessage.configuration) {
      return this.handleConfiguration(envelope, syncMessage.configuration);
    }
    throw new Error('Got empty SyncMessage');
  },
  handleConfiguration(envelope, configuration) {
    window.log.info('got configuration sync message');
    const ev = new Event('configuration');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.configuration = configuration;
    return this.dispatchAndWait(ev);
  },
  handleVerified(envelope, verified) {
    const ev = new Event('verified');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.verified = {
      state: verified.state,
      destination: verified.destination,
      identityKey: verified.identityKey.toArrayBuffer(),
    };
    return this.dispatchAndWait(ev);
  },
  handleRead(envelope, read) {
    const results = [];
    for (let i = 0; i < read.length; i += 1) {
      const ev = new Event('readSync');
      ev.confirm = this.removeFromCache.bind(this, envelope);
      ev.timestamp = envelope.timestamp.toNumber();
      ev.read = {
        timestamp: read[i].timestamp.toNumber(),
        sender: read[i].sender,
      };
      results.push(this.dispatchAndWait(ev));
    }
    return Promise.all(results);
  },
  handleContacts(envelope, contacts) {
    window.log.info('contact sync');
    const { blob } = contacts;

    // Note: we do not return here because we don't want to block the next message on
    //   this attachment download and a lot of processing of that attachment.
    this.handleAttachment(blob).then(attachmentPointer => {
      const results = [];
      const contactBuffer = new ContactBuffer(attachmentPointer.data);
      let contactDetails = contactBuffer.next();
      while (contactDetails !== undefined) {
        const ev = new Event('contact');
        ev.contactDetails = contactDetails;
        results.push(this.dispatchAndWait(ev));

        contactDetails = contactBuffer.next();
      }

      const ev = new Event('contactsync');
      results.push(this.dispatchAndWait(ev));

      return Promise.all(results).then(() => {
        window.log.info('handleContacts: finished');
        return this.removeFromCache(envelope);
      });
    });
  },
  handleGroups(envelope, groups) {
    window.log.info('group sync');
    const { blob } = groups;

    // Note: we do not return here because we don't want to block the next message on
    //   this attachment download and a lot of processing of that attachment.
    this.handleAttachment(blob).then(attachmentPointer => {
      const groupBuffer = new GroupBuffer(attachmentPointer.data);
      let groupDetails = groupBuffer.next();
      const promises = [];
      while (groupDetails !== undefined) {
        groupDetails.id = groupDetails.id.toBinary();
        const ev = new Event('group');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.groupDetails = groupDetails;
        const promise = this.dispatchAndWait(ev).catch(e => {
          window.log.error('error processing group', e);
        });
        groupDetails = groupBuffer.next();
        promises.push(promise);
      }

      Promise.all(promises).then(() => {
        const ev = new Event('groupsync');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        return this.dispatchAndWait(ev);
      });
    });
  },
  handleBlocked(envelope, blocked) {
    window.log.info('Setting these numbers as blocked:', blocked.numbers);
    textsecure.storage.put('blocked', blocked.numbers);

    const groupIds = _.map(blocked.groupIds, groupId => groupId.toBinary());
    window.log.info(
      'Setting these groups as blocked:',
      groupIds.map(groupId => `group(${groupId})`)
    );
    textsecure.storage.put('blocked-groups', groupIds);

    return this.removeFromCache(envelope);
  },
  async savePreKeyBundleMessage(pubKey, preKeyBundleMessage) {
    const [identityKey, preKey, signedKey, signature] = [
      preKeyBundleMessage.identityKey,
      preKeyBundleMessage.preKey,
      preKeyBundleMessage.signedKey,
      preKeyBundleMessage.signature,
    ].map(k => dcodeIO.ByteBuffer.wrap(k).toArrayBuffer());

    const { preKeyId, signedKeyId } = preKeyBundleMessage;

    if (pubKey !== StringView.arrayBufferToHex(identityKey)) {
      throw new Error(
        'Error in savePreKeyBundleMessage: envelope pubkey does not match pubkey in prekey bundle'
      );
    }

    await libloki.storage.saveContactPreKeyBundle({
      pubKey,
      preKeyId,
      signedKeyId,
      preKey,
      signedKey,
      signature,
    });
  },
  isBlocked(number) {
    return textsecure.storage.get('blocked', []).indexOf(number) >= 0;
  },
  isGroupBlocked(groupId) {
    return textsecure.storage.get('blocked-groups', []).indexOf(groupId) >= 0;
  },
  cleanAttachment(attachment) {
    return {
      ..._.omit(attachment, 'thumbnail'),
      id: attachment.id.toString(),
      key: attachment.key ? attachment.key.toString('base64') : null,
      digest: attachment.digest ? attachment.digest.toString('base64') : null,
    };
  },
  async downloadAttachment(attachment) {
    window.log.info('Not downloading attachments.');
    return Promise.reject();

    const encrypted = await this.server.getAttachment(attachment.id);
    const { key, digest, size } = attachment;

    const data = await textsecure.crypto.decryptAttachment(
      encrypted,
      window.Signal.Crypto.base64ToArrayBuffer(key),
      window.Signal.Crypto.base64ToArrayBuffer(digest)
    );

    if (!size || size !== data.byteLength) {
      throw new Error(
        `downloadAttachment: Size ${size} did not match downloaded attachment size ${
          data.byteLength
        }`
      );
    }

    return {
      ..._.omit(attachment, 'digest', 'key'),
      data,
    };
  },
  handleAttachment(attachment) {
    window.log.info('Not handling attachments.');
    return Promise.reject();

    const cleaned = this.cleanAttachment(attachment);
    return this.downloadAttachment(cleaned);
  },
  async handleEndSession(number) {
    window.log.info('got end session');
    const deviceIds = await textsecure.storage.protocol.getDeviceIds(number);
    const identityKey = StringView.hexToArrayBuffer(number);
    let conversation;
    try {
      conversation = window.ConversationController.get(number);
    } catch (e) {
      window.log.error('Error getting conversation: ', number);
    }

    // Bail early if a session reset is already ongoing
    if (conversation.isSessionResetOngoing()) {
      return;
    }

    await Promise.all(
      deviceIds.map(async deviceId => {
        const address = new libsignal.SignalProtocolAddress(number, deviceId);
        // Instead of deleting the sessions now,
        // we process the new prekeys and initiate a new session.
        // The old sessions will get deleted once the correspondant
        // has switch the the new session.
        const [preKey, signedPreKey] = await Promise.all([
          textsecure.storage.protocol.loadContactPreKey(number),
          textsecure.storage.protocol.loadContactSignedPreKey(number),
        ]);
        if (preKey === undefined || signedPreKey === undefined) {
          return;
        }
        const device = {
          identityKey,
          deviceId,
          preKey,
          signedPreKey,
          registrationId: 0,
        };
        const builder = new libsignal.SessionBuilder(
          textsecure.storage.protocol,
          address
        );
        builder.processPreKey(device);
      })
    );
    await conversation.onSessionResetReceived();
  },
  processDecrypted(envelope, decrypted) {
    /* eslint-disable no-bitwise, no-param-reassign */
    const FLAGS = textsecure.protobuf.DataMessage.Flags;

    // Now that its decrypted, validate the message and clean it up for consumer
    //   processing
    // Note that messages may (generally) only perform one action and we ignore remaining
    //   fields after the first action.

    if (decrypted.flags == null) {
      decrypted.flags = 0;
    }
    if (decrypted.expireTimer == null) {
      decrypted.expireTimer = 0;
    }

    if (decrypted.flags & FLAGS.END_SESSION) {
      decrypted.body = null;
      decrypted.attachments = [];
      decrypted.group = null;
      return Promise.resolve(decrypted);
    } else if (decrypted.flags & FLAGS.EXPIRATION_TIMER_UPDATE) {
      decrypted.body = null;
      decrypted.attachments = [];
    } else if (decrypted.flags & FLAGS.PROFILE_KEY_UPDATE) {
      decrypted.body = null;
      decrypted.attachments = [];
    } else if (decrypted.flags !== 0) {
      throw new Error('Unknown flags in message');
    }

    const promises = [];

    if (decrypted.group !== null) {
      decrypted.group.id = decrypted.group.id.toBinary();

      switch (decrypted.group.type) {
        case textsecure.protobuf.GroupContext.Type.UPDATE:
          decrypted.body = null;
          decrypted.attachments = [];
          break;
        case textsecure.protobuf.GroupContext.Type.QUIT:
          decrypted.body = null;
          decrypted.attachments = [];
          break;
        case textsecure.protobuf.GroupContext.Type.DELIVER:
          decrypted.group.name = null;
          decrypted.group.members = [];
          decrypted.group.avatar = null;
          break;
        default:
          this.removeFromCache(envelope);
          throw new Error('Unknown group message type');
      }
    }

    const attachmentCount = decrypted.attachments.length;
    const ATTACHMENT_MAX = 32;
    if (attachmentCount > ATTACHMENT_MAX) {
      throw new Error(
        `Too many attachments: ${attachmentCount} included in one message, max is ${ATTACHMENT_MAX}`
      );
    }

    // Here we go from binary to string/base64 in all AttachmentPointer digest/key fields

    if (
      decrypted.group &&
      decrypted.group.type === textsecure.protobuf.GroupContext.Type.UPDATE
    ) {
      if (decrypted.group.avatar !== null) {
        decrypted.group.avatar = this.cleanAttachment(decrypted.group.avatar);
      }
    }

    decrypted.attachments = (decrypted.attachments || []).map(
      this.cleanAttachment.bind(this)
    );
    decrypted.preview = (decrypted.preview || []).map(item => {
      const { image } = item;

      if (!image) {
        return item;
      }

      return {
        ...item,
        image: this.cleanAttachment(image),
      };
    });
    decrypted.contact = (decrypted.contact || []).map(item => {
      const { avatar } = item;

      if (!avatar || !avatar.avatar) {
        return item;
      }

      return {
        ...item,
        avatar: {
          ...item.avatar,
          avatar: this.cleanAttachment(item.avatar.avatar),
        },
      };
    });

    if (decrypted.quote && decrypted.quote.id) {
      decrypted.quote.id = decrypted.quote.id.toNumber();
    }

    if (decrypted.quote) {
      decrypted.quote.attachments = (decrypted.quote.attachments || []).map(
        item => {
          const { thumbnail } = item;

          if (!thumbnail) {
            return item;
          }

          return {
            ...item,
            thumbnail: this.cleanAttachment(item.thumbnail),
          };
        }
      );
    }

    return Promise.all(promises).then(() => decrypted);
    /* eslint-enable no-bitwise, no-param-reassign */
  },
});

window.textsecure = window.textsecure || {};

textsecure.MessageReceiver = function MessageReceiverWrapper(
  username,
  password,
  signalingKey,
  options
) {
  const messageReceiver = new MessageReceiver(
    username,
    password,
    signalingKey,
    options
  );
  this.addEventListener = messageReceiver.addEventListener.bind(
    messageReceiver
  );
  this.removeEventListener = messageReceiver.removeEventListener.bind(
    messageReceiver
  );
  this.getStatus = messageReceiver.getStatus.bind(messageReceiver);
  this.close = messageReceiver.close.bind(messageReceiver);
  this.savePreKeyBundleMessage = messageReceiver.savePreKeyBundleMessage.bind(
    messageReceiver
  );

  this.downloadAttachment = messageReceiver.downloadAttachment.bind(
    messageReceiver
  );
  this.stopProcessing = messageReceiver.stopProcessing.bind(messageReceiver);

  messageReceiver.connect();
};

textsecure.MessageReceiver.prototype = {
  constructor: textsecure.MessageReceiver,
};

textsecure.MessageReceiver.stringToArrayBuffer =
  MessageReceiver.stringToArrayBuffer;
textsecure.MessageReceiver.arrayBufferToString =
  MessageReceiver.arrayBufferToString;
textsecure.MessageReceiver.stringToArrayBufferBase64 =
  MessageReceiver.stringToArrayBufferBase64;
textsecure.MessageReceiver.arrayBufferToStringBase64 =
  MessageReceiver.arrayBufferToStringBase64;
