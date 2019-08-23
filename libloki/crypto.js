/* global
  window,
  libsignal,
  textsecure,
  StringView,
  Multibase,
  TextEncoder,
  TextDecoder,
  dcodeIO
*/

// eslint-disable-next-line func-names
(function() {
  window.libloki = window.libloki || {};

  class FallBackDecryptionError extends Error {}

  const IV_LENGTH = 16;

  async function DHEncrypt(symmetricKey, plainText) {
    const iv = libsignal.crypto.getRandomBytes(IV_LENGTH);
    const ciphertext = await libsignal.crypto.encrypt(
      symmetricKey,
      plainText,
      iv
    );
    const ivAndCiphertext = new Uint8Array(
      iv.byteLength + ciphertext.byteLength
    );
    ivAndCiphertext.set(new Uint8Array(iv));
    ivAndCiphertext.set(new Uint8Array(ciphertext), iv.byteLength);
    return ivAndCiphertext;
  }

  async function DHDecrypt(symmetricKey, ivAndCiphertext) {
    const iv = ivAndCiphertext.slice(0, IV_LENGTH);
    const cipherText = ivAndCiphertext.slice(IV_LENGTH);
    return libsignal.crypto.decrypt(symmetricKey, cipherText, iv);
  }

  class FallBackSessionCipher {
    constructor(address) {
      this.identityKeyString = address.getName();
      this.pubKey = StringView.hexToArrayBuffer(address.getName());
    }

    async encrypt(plaintext) {
      const myKeyPair = await textsecure.storage.protocol.getIdentityKeyPair();
      const myPrivateKey = myKeyPair.privKey;
      const symmetricKey = libsignal.Curve.calculateAgreement(
        this.pubKey,
        myPrivateKey
      );
      const ivAndCiphertext = await DHEncrypt(symmetricKey, plaintext);
      return {
        type: textsecure.protobuf.Envelope.Type.FRIEND_REQUEST,
        body: ivAndCiphertext,
        registrationId: null,
      };
    }

    async decrypt(ivAndCiphertext) {
      const myKeyPair = await textsecure.storage.protocol.getIdentityKeyPair();
      const myPrivateKey = myKeyPair.privKey;
      const symmetricKey = libsignal.Curve.calculateAgreement(
        this.pubKey,
        myPrivateKey
      );
      try {
        return await DHDecrypt(symmetricKey, ivAndCiphertext);
      } catch (e) {
        throw new FallBackDecryptionError(
          `Could not decrypt message from ${
            this.identityKeyString
          } using FallBack encryption.`
        );
      }
    }
  }

  const base32zIndex = Multibase.names.indexOf('base32z');
  const base32zCode = Multibase.codes[base32zIndex];

  function bufferToArrayBuffer(buf) {
    const ab = new ArrayBuffer(buf.length);
    const view = new Uint8Array(ab);
    for (let i = 0; i < buf.length; i += 1) {
      view[i] = buf[i];
    }
    return ab;
  }

  function decodeSnodeAddressToPubKey(snodeAddress) {
    const snodeAddressClean = snodeAddress
      .replace('.snode', '')
      .replace('https://', '')
      .replace('http://', '');
    return Multibase.decode(`${base32zCode}${snodeAddressClean}`);
  }

  class LokiSnodeChannel {
    constructor() {
      this._ephemeralKeyPair = libsignal.Curve.generateKeyPair();
      // Signal protocol prepends with "0x05"
      this._ephemeralKeyPair.pubKey = this._ephemeralKeyPair.pubKey.slice(1);
      this._ephemeralPubKeyHex = StringView.arrayBufferToHex(
        this._ephemeralKeyPair.pubKey
      );
      this._cache = {};
    }

    async _getSymmetricKey(snodeAddress) {
      if (snodeAddress in this._cache) {
        return this._cache[snodeAddress];
      }
      const ed25519PubKey = decodeSnodeAddressToPubKey(snodeAddress);
      const sodium = await window.getSodium();
      const curve25519PubKey = sodium.crypto_sign_ed25519_pk_to_curve25519(
        ed25519PubKey
      );
      const snodePubKeyArrayBuffer = bufferToArrayBuffer(curve25519PubKey);
      const symmetricKey = libsignal.Curve.calculateAgreement(
        snodePubKeyArrayBuffer,
        this._ephemeralKeyPair.privKey
      );
      this._cache[snodeAddress] = symmetricKey;
      return symmetricKey;
    }

    getChannelPublicKeyHex() {
      return this._ephemeralPubKeyHex;
    }

    async decrypt(snodeAddress, ivAndCipherTextBase64) {
      const ivAndCipherText = dcodeIO.ByteBuffer.wrap(
        ivAndCipherTextBase64,
        'base64'
      ).toArrayBuffer();
      const symmetricKey = await this._getSymmetricKey(snodeAddress);
      try {
        const decrypted = await DHDecrypt(symmetricKey, ivAndCipherText);
        const decoder = new TextDecoder();
        return decoder.decode(decrypted);
      } catch (e) {
        return ivAndCipherText;
      }
    }

    async encrypt(snodeAddress, plainText) {
      if (typeof plainText === 'string') {
        const textEncoder = new TextEncoder();
        // eslint-disable-next-line no-param-reassign
        plainText = textEncoder.encode(plainText);
      }
      const symmetricKey = await this._getSymmetricKey(snodeAddress);
      const cipherText = await DHEncrypt(symmetricKey, plainText);
      return dcodeIO.ByteBuffer.wrap(cipherText).toString('base64');
    }
  }

  async function generateSignatureForPairing(secondaryPubKey, type) {
    const pubKeyArrayBuffer = StringView.hexToArrayBuffer(secondaryPubKey);
    // Make sure the signature includes the pairing action (pairing or unpairing)
    const len = pubKeyArrayBuffer.byteLength;
    const data = new Uint8Array(len + 1);
    data.set(new Uint8Array(pubKeyArrayBuffer), 0);
    data[len] = type;

    const myKeyPair = await textsecure.storage.protocol.getIdentityKeyPair();
    const signature = await libsignal.Curve.async.calculateSignature(
      myKeyPair.privKey,
      data.buffer
    );
    return signature;
  }

  async function verifyPairingAuthorisation(
    primaryDevicePubKey,
    secondaryPubKey,
    signature,
    type
  ) {
    const secondaryPubKeyArrayBuffer = StringView.hexToArrayBuffer(
      secondaryPubKey
    );
    const primaryDevicePubKeyArrayBuffer = StringView.hexToArrayBuffer(
      primaryDevicePubKey
    );
    const len = secondaryPubKeyArrayBuffer.byteLength;
    const data = new Uint8Array(len + 1);
    // For REQUEST type message, the secondary device signs the primary device pubkey
    // For GRANT type message, the primary device signs the secondary device pubkey
    let issuer;
    if (type === textsecure.protobuf.PairingAuthorisationMessage.Type.GRANT) {
      data.set(new Uint8Array(secondaryPubKeyArrayBuffer));
      issuer = primaryDevicePubKeyArrayBuffer;
    } else if (
      type === textsecure.protobuf.PairingAuthorisationMessage.Type.REQUEST
    ) {
      data.set(new Uint8Array(primaryDevicePubKeyArrayBuffer));
      issuer = secondaryPubKeyArrayBuffer;
    }
    data[len] = type;
    // Throws for invalid signature
    await libsignal.Curve.async.verifySignature(issuer, data.buffer, signature);
  }

  const snodeCipher = new LokiSnodeChannel();

  window.libloki.crypto = {
    DHEncrypt,
    DHDecrypt,
    FallBackSessionCipher,
    FallBackDecryptionError,
    snodeCipher,
    generateSignatureForPairing,
    verifyPairingAuthorisation,
    // for testing
    _LokiSnodeChannel: LokiSnodeChannel,
    _decodeSnodeAddressToPubKey: decodeSnodeAddressToPubKey,
  };
})();
