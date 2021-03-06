/* global window, dcodeIO, textsecure */

// eslint-disable-next-line func-names
(function() {
  let server;
  const SUCCESS_POLL_TIME = 100;
  const FAIL_POLL_TIME = 2000;

  function stringToArrayBufferBase64(string) {
    return dcodeIO.ByteBuffer.wrap(string, 'base64').toArrayBuffer();
  }

  const Response = function Response(options) {
    this.verb = options.verb || options.type;
    this.path = options.path || options.url;
    this.body = options.body || options.data;
    this.success = options.success;
    this.error = options.error;
    this.id = options.id;

    if (this.id === undefined) {
      const bits = new Uint32Array(2);
      window.crypto.getRandomValues(bits);
      this.id = dcodeIO.Long.fromBits(bits[0], bits[1], true);
    }

    if (this.body === undefined) {
      this.body = null;
    }
  };

  const IncomingHttpResponse = function IncomingHttpResponse(options) {
    const request = new Response(options);

    this.verb = request.verb;
    this.path = request.path;
    this.body = request.body;

    this.respond = (status, message) => {
      // Mock websocket response
      window.log.info(status, message);
    };
  };

  window.HttpResource = function HttpResource(_server, opts = {}) {
    server = _server;
    let { handleRequest } = opts;
    if (typeof handleRequest !== 'function') {
      handleRequest = request => request.respond(404, 'Not found');
    }
    let connected = true;

    this.handleMessage = (message, options = {}) => {
      try {
        const dataPlaintext = stringToArrayBufferBase64(message);
        const messageBuf = textsecure.protobuf.WebSocketMessage.decode(
          dataPlaintext
        );
        if (
          messageBuf.type === textsecure.protobuf.WebSocketMessage.Type.REQUEST
        ) {
          handleRequest(
            new IncomingHttpResponse({
              verb: messageBuf.request.verb,
              path: messageBuf.request.path,
              body: messageBuf.request.body,
              id: messageBuf.request.id,
            }),
            options
          );
        }
      } catch (error) {
        const info = {
          message,
          error: error.message,
        };
        window.log.warn('HTTP-Resources Failed to handle message:', info);
      }
    };

    this.pollServer = async callback => {
      try {
        await server.retrieveMessages(messages => {
          messages.forEach(message => {
            const { data } = message;
            this.handleMessage(data);
          });
        });
        connected = true;
      } catch (err) {
        window.log.error('Polling error: ', err);
        connected = false;
      }
      const pollTime = connected ? SUCCESS_POLL_TIME : FAIL_POLL_TIME;
      callback(connected);
      setTimeout(() => {
        this.pollServer(callback);
      }, pollTime);
    };

    this.isConnected = function isConnected() {
      return connected;
    };
  };
})();
