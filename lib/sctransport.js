var Emitter = require('component-emitter');
var Response = require('./response').Response;
var querystring = require('querystring');
var WebSocket;
var createWebSocket;

if (global.WebSocket) {
  WebSocket = global.WebSocket;
  createWebSocket = function (uri, options) {
    return new WebSocket(uri);
  };
} else {
  WebSocket = require('./wxWebSocket');
  createWebSocket = function (uri, options) {
    return new WebSocket(uri, null, options);
  };
}
// else {
//   WebSocket = require('ws');
//   createWebSocket = function (uri, options) {
//     return new WebSocket(uri, null, options);
//   };
// }

var scErrors = require('sc-errors');
var TimeoutError = scErrors.TimeoutError;
var BadConnectionError = scErrors.BadConnectionError;


var SCTransport = function (authEngine, codecEngine, options) {
  var self = this;

  this.state = this.CLOSED;
  this.auth = authEngine;
  this.codec = codecEngine;
  this.options = options;
  this.connectTimeout = options.connectTimeout;
  this.pingTimeout = options.ackTimeout;
  this.pingTimeoutDisabled = !!options.pingTimeoutDisabled;
  this.callIdGenerator = options.callIdGenerator;
  this.authTokenName = options.authTokenName;

  this._pingTimeoutTicker = null;
  this._callbackMap = {};
  this._batchSendList = [];

  // Open the connection.

  this.state = this.CONNECTING;
  var uri = this.uri();

  var wsSocket = createWebSocket(uri, this.options);
  wsSocket.binaryType = this.options.binaryType;

  this.socket = wsSocket;

  wsSocket.onopen = function () {
    self._onOpen();
  };

  wsSocket.onclose = function (event) {
    var code;
    if (event.code == null) {
      // This is to handle an edge case in React Native whereby
      // event.code is undefined when the mobile device is locked.
      // TODO: This is not perfect since this condition could also apply to
      // an abnormal close (no close control frame) which would be a 1006.
      code = 1005;
    } else {
      code = event.code;
    }
    self._onClose(code, event.reason);
  };

  wsSocket.onmessage = function (message, flags) {
    self._onMessage(message.data);
  };

  wsSocket.onerror = function (error) {
    // The onclose event will be called automatically after the onerror event
    // if the socket is connected - Otherwise, if it's in the middle of
    // connecting, we want to close it manually with a 1006 - This is necessary
    // to prevent inconsistent behavior when running the client in Node.js
    // vs in a browser.

    if (self.state === self.CONNECTING) {
      self._onClose(1006);
    }
  };

  this._connectTimeoutRef = setTimeout(function () {
    self._onClose(4007);
    self.socket.close(4007);
  }, this.connectTimeout);
};

SCTransport.prototype = Object.create(Emitter.prototype);

SCTransport.CONNECTING = SCTransport.prototype.CONNECTING = 'connecting';
SCTransport.OPEN = SCTransport.prototype.OPEN = 'open';
SCTransport.CLOSED = SCTransport.prototype.CLOSED = 'closed';

SCTransport.prototype.uri = function () {
  var query = this.options.query || {};
  var schema = this.options.secure ? 'wss' : 'ws';

  if (this.options.timestampRequests) {
    query[this.options.timestampParam] = (new Date()).getTime();
  }

  query = querystring.encode(query);

  if (query.length) {
    query = '?' + query;
  }

  var host;
  if (this.options.host) {
    host = this.options.host;
  } else {
    var port = '';

    if (this.options.port && ((schema == 'wss' && this.options.port != 443)
      || (schema == 'ws' && this.options.port != 80))) {
      port = ':' + this.options.port;
    }
    host = this.options.hostname + port;
  }

  return schema + '://' + host + this.options.path + query;
};

SCTransport.prototype._onOpen = function () {
  var self = this;

  clearTimeout(this._connectTimeoutRef);
  this._resetPingTimeout();

  this._handshake(function (err, status) {
    if (err) {
      var statusCode;
      if (status && status.code) {
        statusCode = status.code;
      } else {
        statusCode = 4003;
      }
      self._onError(err);
      self._onClose(statusCode, err.toString());
      self.socket.close(statusCode);
    } else {
      self.state = self.OPEN;
      Emitter.prototype.emit.call(self, 'open', status);
      self._resetPingTimeout();
    }
  });
};

SCTransport.prototype._handshake = function (callback) {
  var self = this;
  this.auth.loadToken(this.authTokenName, function (err, token) {
    if (err) {
      callback(err);
    } else {
      // Don't wait for this.state to be 'open'.
      // The underlying WebSocket (this.socket) is already open.
      var options = {
        force: true
      };
      self.emit('#handshake', {
        authToken: token
      }, options, function (err, status) {
        if (status) {
          // Add the token which was used as part of authentication attempt
          // to the status object.
          status.authToken = token;
          if (status.authError) {
            status.authError = scErrors.hydrateError(status.authError);
          }
        }
        callback(err, status);
      });
    }
  });
};

SCTransport.prototype._abortAllPendingEventsDueToBadConnection = function (failureType) {
  for (var i in this._callbackMap) {
    if (this._callbackMap.hasOwnProperty(i)) {
      var eventObject = this._callbackMap[i];
      delete this._callbackMap[i];

      clearTimeout(eventObject.timeout);
      delete eventObject.timeout;

      var errorMessage = "Event '" + eventObject.event +
        "' was aborted due to a bad connection";
      var badConnectionError = new BadConnectionError(errorMessage, failureType);

      var callback = eventObject.callback;
      delete eventObject.callback;
      callback.call(eventObject, badConnectionError, eventObject);
    }
  }
};

SCTransport.prototype._onClose = function (code, data) {
  delete this.socket.onopen;
  delete this.socket.onclose;
  delete this.socket.onmessage;
  delete this.socket.onerror;

  clearTimeout(this._connectTimeoutRef);
  clearTimeout(this._pingTimeoutTicker);
  clearTimeout(this._batchTimeout);

  if (this.state == this.OPEN) {
    this.state = this.CLOSED;
    Emitter.prototype.emit.call(this, 'close', code, data);
    this._abortAllPendingEventsDueToBadConnection('disconnect');

  } else if (this.state == this.CONNECTING) {
    this.state = this.CLOSED;
    Emitter.prototype.emit.call(this, 'openAbort', code, data);
    this._abortAllPendingEventsDueToBadConnection('connectAbort');
  }
};

SCTransport.prototype._handleEventObject = function (obj, message) {
  if (obj && obj.event != null) {
    var response = new Response(this, obj.cid);
    Emitter.prototype.emit.call(this, 'event', obj.event, obj.data, response);
  } else if (obj && obj.rid != null) {
    var eventObject = this._callbackMap[obj.rid];
    if (eventObject) {
      clearTimeout(eventObject.timeout);
      delete eventObject.timeout;
      delete this._callbackMap[obj.rid];

      if (eventObject.callback) {
        var rehydratedError = scErrors.hydrateError(obj.error);
        eventObject.callback(rehydratedError, obj.data);
      }
    }
  } else {
    Emitter.prototype.emit.call(this, 'event', 'raw', message);
  }
};

SCTransport.prototype._onMessage = function (message) {
  Emitter.prototype.emit.call(this, 'event', 'message', message);

  var obj = this.decode(message);

  // If ping
  if (obj == '#1') {
    this._resetPingTimeout();
    if (this.socket.readyState == this.socket.OPEN) {
      this.sendObject('#2');
    }
  } else {
    if (Array.isArray(obj)) {
      var len = obj.length;
      for (var i = 0; i < len; i++) {
        this._handleEventObject(obj[i], message);
      }
    } else {
      this._handleEventObject(obj, message);
    }
  }
};

SCTransport.prototype._onError = function (err) {
  Emitter.prototype.emit.call(this, 'error', err);
};

SCTransport.prototype._resetPingTimeout = function () {
  if (this.pingTimeoutDisabled) {
    return;
  }
  var self = this;

  var now = (new Date()).getTime();
  clearTimeout(this._pingTimeoutTicker);

  this._pingTimeoutTicker = setTimeout(function () {
    self._onClose(4000);
    self.socket.close(4000);
  }, this.pingTimeout);
};

SCTransport.prototype.getBytesReceived = function () {
  return this.socket.bytesReceived;
};

SCTransport.prototype.close = function (code, data) {
  code = code || 1000;

  if (this.state == this.OPEN) {
    var packet = {
      code: code,
      data: data
    };
    this.emit('#disconnect', packet);

    this._onClose(code, data);
    this.socket.close(code);

  } else if (this.state == this.CONNECTING) {
    this._onClose(code, data);
    this.socket.close(code);
  }
};

SCTransport.prototype.emitObject = function (eventObject, options) {
  var simpleEventObject = {
    event: eventObject.event,
    data: eventObject.data
  };

  if (eventObject.callback) {
    simpleEventObject.cid = eventObject.cid = this.callIdGenerator();
    this._callbackMap[eventObject.cid] = eventObject;
  }

  this.sendObject(simpleEventObject, options);

  return eventObject.cid || null;
};

SCTransport.prototype._handleEventAckTimeout = function (eventObject) {
  if (eventObject.cid) {
    delete this._callbackMap[eventObject.cid];
  }
  delete eventObject.timeout;

  var callback = eventObject.callback;
  if (callback) {
    delete eventObject.callback;
    var error = new TimeoutError("Event response for '" + eventObject.event + "' timed out");
    callback.call(eventObject, error, eventObject);
  }
};

// The last two optional arguments (a and b) can be options and/or callback
SCTransport.prototype.emit = function (event, data, a, b) {
  var self = this;

  var callback, options;

  if (b) {
    options = a;
    callback = b;
  } else {
    if (a instanceof Function) {
      options = {};
      callback = a;
    } else {
      options = a;
    }
  }

  var eventObject = {
    event: event,
    data: data,
    callback: callback
  };

  if (callback && !options.noTimeout) {
    eventObject.timeout = setTimeout(function () {
      self._handleEventAckTimeout(eventObject);
    }, this.options.ackTimeout);
  }

  var cid = null;
  if (this.state == this.OPEN || options.force) {
    cid = this.emitObject(eventObject, options);
  }
  return cid;
};

SCTransport.prototype.cancelPendingResponse = function (cid) {
  delete this._callbackMap[cid];
};

SCTransport.prototype.decode = function (message) {
  return this.codec.decode(message);
};

SCTransport.prototype.encode = function (object) {
  return this.codec.encode(object);
};

SCTransport.prototype.send = function (data) {
  if (this.socket.readyState != this.socket.OPEN) {
    this._onClose(1005);
  } else {
    this.socket.send(data);
  }
};

SCTransport.prototype.serializeObject = function (object) {
  var str, formatError;
  try {
    str = this.encode(object);
  } catch (err) {
    formatError = err;
    this._onError(formatError);
  }
  if (!formatError) {
    return str;
  }
  return null;
};

SCTransport.prototype.sendObjectBatch = function (object) {
  var self = this;

  this._batchSendList.push(object);
  if (this._batchTimeout) {
    return;
  }

  this._batchTimeout = setTimeout(function () {
    delete self._batchTimeout;
    if (self._batchSendList.length) {
      var str = self.serializeObject(self._batchSendList);
      if (str != null) {
        self.send(str);
      }
      self._batchSendList = [];
    }
  }, this.options.pubSubBatchDuration || 0);
};

SCTransport.prototype.sendObjectSingle = function (object) {
  var str = this.serializeObject(object);
  if (str != null) {
    this.send(str);
  }
};

SCTransport.prototype.sendObject = function (object, options) {
  if (options && options.batch) {
    this.sendObjectBatch(object);
  } else {
    this.sendObjectSingle(object);
  }
};

module.exports.SCTransport = SCTransport;
