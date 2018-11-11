var assert = require('assert');
var socketClusterServer = require('socketcluster-server');
var socketClusterClient = require('../');
var localStorage = require('localStorage');

// Add to the global scope like in browser.
global.localStorage = localStorage;

var portNumber = 8008;

var clientOptions;
var serverOptions;

var allowedUsers = {
  bob: true,
  kate: true,
  alice: true
};

var server, client;
var validSignedAuthTokenBob = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImJvYiIsImV4cCI6MzE2Mzc1ODk3ODIxNTQ4NywiaWF0IjoxNTAyNzQ3NzQ2fQ.GLf_jqi_qUSCRahxe2D2I9kD8iVIs0d4xTbiZMRiQq4';
var validSignedAuthTokenKate = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImthdGUiLCJleHAiOjMxNjM3NTg5NzgyMTU0ODcsImlhdCI6MTUwMjc0Nzc5NX0.Yfb63XvDt9Wk0wHSDJ3t7Qb1F0oUVUaM5_JKxIE2kyw';
var invalidSignedAuthToken = 'fakebGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fakec2VybmFtZSI6ImJvYiIsImlhdCI6MTUwMjYyNTIxMywiZXhwIjoxNTAyNzExNjEzfQ.fakemYcOOjM9bzmS4UYRvlWSk_lm3WGHvclmFjLbyOk';

var TOKEN_EXPIRY_IN_SECONDS = 60 * 60 * 24 * 366 * 5000;

var wait = function (duration) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, duration);
  });
};

var connectionHandler = function (socket) {
  async function handleLogin() {
    var rpc = await socket.procedure('login').once();
    if (allowedUsers[rpc.data.username]) {
      rpc.data.exp = Math.round(Date.now() / 1000) + TOKEN_EXPIRY_IN_SECONDS;
      socket.setAuthToken(rpc.data);
      rpc.end();
    } else {
      var err = new Error('Failed to login');
      err.name = 'FailedLoginError';
      rpc.error(err);
    }
  }
  handleLogin();

  async function handleSetAuthKey() {
    var rpc = await socket.procedure('setAuthKey').once();
    server.signatureKey = rpc.data;
    server.verificationKey = rpc.data;
    rpc.end();
  }
  handleSetAuthKey();

  async function handlePerformTask() {
    for await (let rpc of socket.procedure('performTask')) {
      setTimeout(function () {
        rpc.respond();
      }, 1000);
    }
  }
  handlePerformTask();
};

describe('Integration tests', function () {
  beforeEach('Run the server before start', async function () {
    serverOptions = {
      authKey: 'testkey',
      ackTimeout: 200
    };

    server = socketClusterServer.listen(portNumber, serverOptions);
    async function handleServerConnection() {
      for await (let socket of server.listener('connection')) {
        connectionHandler(socket);
      }
    }
    handleServerConnection();

    server.addMiddleware(server.MIDDLEWARE_AUTHENTICATE, async function (req) {
      if (req.authToken.username === 'alice') {
        var err = new Error('Blocked by MIDDLEWARE_AUTHENTICATE');
        err.name = 'AuthenticateMiddlewareError';
        throw err;
      }
    });

    clientOptions = {
      hostname: '127.0.0.1',
      port: portNumber,
      multiplex: false,
      ackTimeout: 200
    };

    await server.listener('ready').once();
  });

  afterEach('Shut down server afterwards', async function () {
    var cleanupTasks = [];
    global.localStorage.removeItem('socketCluster.authToken');
    if (client) {
      if (client.state !== client.CLOSED) {
        cleanupTasks.push(
          Promise.race([
            client.listener('disconnect').once(),
            client.listener('connectAbort').once()
          ])
        );
        client.destroy();
      } else {
        client.destroy();
      }
    }
    cleanupTasks.push(
      server
      .close()
      .then(() => {
        portNumber++;
      })
    );
    await Promise.all(cleanupTasks);
  });

  describe('Creation', function () {
    it('Should reuse socket if multiplex is true and options are the same', async function () {
      clientOptions = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: true
      };

      var clientA = socketClusterClient.create(clientOptions);
      var clientB = socketClusterClient.create(clientOptions);

      assert.equal(clientA, clientB);
      clientA.destroy();
      clientB.destroy();
    });

    it('Should automatically connect socket on creation by default', async function () {
      clientOptions = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: false
      };

      client = socketClusterClient.create(clientOptions);

      assert.equal(client.state, client.CONNECTING);
    });

    it('Should not automatically connect socket if autoConnect is set to false', async function () {
      clientOptions = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: false,
        autoConnect: false
      };

      client = socketClusterClient.create(clientOptions);

      assert.equal(client.state, client.CLOSED);
    });

    it('Should automatically connect socket if multiplex is true, autoConnect is set to false the first time and socket create is called with autoConnect true the second time', async function () {
      var clientOptionsA = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: true,
        autoConnect: false
      };

      var clientA = socketClusterClient.create(clientOptionsA);

      assert.equal(clientA.state, clientA.CLOSED);

      var clientOptionsB = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: true,
        autoConnect: true
      };

      var clientB = socketClusterClient.create(clientOptionsB);

      assert.equal(clientB.state, clientB.CONNECTING);

      clientA.destroy();
      clientB.destroy();
    });

    it('Should not automatically connect socket if multiplex is true, autoConnect is set to false and socket create is called a second time with autoConnect false', async function () {
      clientOptions = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: true,
        autoConnect: false
      };

      var clientA = socketClusterClient.create(clientOptions);

      assert.equal(clientA.state, clientA.CLOSED);

      var clientB = socketClusterClient.create(clientOptions);

      assert.equal(clientB.state, clientB.CLOSED);

      clientA.destroy();
      clientB.destroy();
    });
  });

  describe('Errors', function () {
    it('Should be able to emit the error event locally on the socket', async function () {
      client = socketClusterClient.create(clientOptions);
      var error = null;

      (async () => {
        for await (let err of client.listener('error')) {
          error = err;
        }
      })();

      (async () => {
        for await (let status of client.listener('connect')) {
          var error = new Error('Custom error');
          error.name = 'CustomError';
          client.emit('error', error);
        }
      })();

      await wait(100);

      assert.notEqual(error, null);
      assert.equal(error.name, 'CustomError');
    });
  });

  describe('Authentication', function () {
    it('Should not send back error if JWT is not provided in handshake', function (done) {
      client = socketClusterClient.create(clientOptions);
      client.once('connect', function (status) {
        assert.equal(status.authError === undefined, true);
        done()
      });
    });

    it('Should be authenticated on connect if previous JWT token is present', function (done) {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);
      client = socketClusterClient.create(clientOptions);
      client.once('connect', function (statusA) {
        assert.equal(client.authState, 'authenticated');
        assert.equal(statusA.isAuthenticated, true);
        assert.equal(statusA.authError === undefined, true);
        done();
      });
    });

    it('Should send back error if JWT is invalid during handshake', function (done) {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);
      client = socketClusterClient.create(clientOptions);

      client.once('connect', (statusA) => {
        assert.notEqual(statusA, null);
        assert.equal(statusA.isAuthenticated, true);
        assert.equal(statusA.authError, null);

        assert.notEqual(client.signedAuthToken, null);
        assert.notEqual(client.authToken, null);

        // Change the setAuthKey to invalidate the current token.
        client.invoke('setAuthKey', 'differentAuthKey')
        .then(() => {
          client.once('disconnect', () => {
            client.once('connect', (statusB) => {
              assert.equal(statusB.isAuthenticated, false);
              assert.notEqual(statusB.authError, null);
              assert.equal(statusB.authError.name, 'AuthTokenInvalidError');

              // When authentication fails, the auth token properties on the client
              // socket should be set to null; that way it's not going to keep
              // throwing the same error every time the socket tries to connect.
              assert.equal(client.signedAuthToken, null);
              assert.equal(client.authToken, null);

              // Set authKey back to what it was.
              client.invoke('setAuthKey', serverOptions.authKey)
              .then(() => {
                done();
              });
            });

            client.connect();
          });

          client.disconnect();
        });
      });
    });

    it('Should allow switching between users', function (done) {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);
      client = socketClusterClient.create(clientOptions);
      var authenticateTriggered = false;
      var authStateChangeTriggered = false;
      client.once('connect', function (statusA) {
        assert.notEqual(client.authToken, null);
        assert.equal(client.authToken.username, 'bob');

        client.invoke('login', {username: 'alice'});

        client.once('authenticate', function (signedToken) {
          authenticateTriggered = true;
          assert.equal(client.authState, 'authenticated');
          assert.notEqual(client.authToken, null);
          assert.equal(client.authToken.username, 'alice');
        });

        client.once('authStateChange', function (signedToken) {
          authStateChangeTriggered = true;
        });

        setTimeout(function () {
          assert.equal(authenticateTriggered, true);
          assert.equal(authStateChangeTriggered, false);
          done();
        }, 100);
      });
    });

    it('Token should be available by the time the login Promise resolves if token engine signing is synchronous', function (done) {
      var port = 8509;
      server = socketClusterServer.listen(port, {
        authKey: serverOptions.authKey,
        authSignAsync: false
      });
      server.once('connection', connectionHandler);
      server.once('ready', function () {
        client = socketClusterClient.create({
          hostname: clientOptions.hostname,
          port: port,
          multiplex: false
        });
        client.once('connect', function (statusA) {
          client.invoke('login', {username: 'bob'})
          .then(function () {
            assert.equal(client.authState, 'authenticated');
            assert.notEqual(client.authToken, null);
            assert.equal(client.authToken.username, 'bob');
            done();
          });
        });
      });
    });

    it('If token engine signing is asynchronous, authentication can be captured using the authenticate event', function (done) {
      var port = 8510;
      server = socketClusterServer.listen(port, {
        authKey: serverOptions.authKey,
        authSignAsync: true
      });
      server.once('connection', connectionHandler);
      server.once('ready', function () {
        client = socketClusterClient.create({
          hostname: clientOptions.hostname,
          port: port,
          multiplex: false
        });
        client.once('connect', function (statusA) {
          client.invoke('login', {username: 'bob'});
          client.once('authenticate', function (newSignedToken) {
            assert.equal(client.authState, 'authenticated');
            assert.notEqual(client.authToken, null);
            assert.equal(client.authToken.username, 'bob');
            done();
          });
        });
      });
    });

    it('Should still work if token verification is asynchronous', function (done) {
      var port = 8511;
      server = socketClusterServer.listen(port, {
        authKey: serverOptions.authKey,
        authVerifyAsync: false
      });
      server.once('connection', connectionHandler);
      server.once('ready', function () {
        client = socketClusterClient.create({
          hostname: clientOptions.hostname,
          port: port,
          multiplex: false
        });
        client.once('connect', function (statusA) {
          client.once('authenticate', function (newSignedToken) {
            client.once('disconnect', function () {
              client.once('connect', function (statusB) {
                assert.equal(statusB.isAuthenticated, true);
                assert.notEqual(client.authToken, null);
                assert.equal(client.authToken.username, 'bob');
                done();
              });
              client.connect();
            });
          });
          client.invoke('login', {username: 'bob'})
          .then(() => {
            client.disconnect();
          });
        });
      });
    });

    it('Should start out in pending authState and switch to unauthenticated if no token exists', function (done) {
      client = socketClusterClient.create(clientOptions);
      assert.equal(client.authState, 'unauthenticated');

      var handler = function (status) {
        throw new Error('authState should not change after connecting without a token');
      };

      client.once('authStateChange', handler);

      setTimeout(function () {
        client.off('authStateChange', handler);
        done();
      }, 1000);
    });

    it('Should deal with auth engine errors related to saveToken function', function (done) {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);
      client = socketClusterClient.create(clientOptions);

      var caughtError;
      client.on('error', function (err) {
        caughtError = err;
      });

      client.once('connect', function () {
        var oldSaveTokenFunction = client.auth.saveToken;
        client.auth.saveToken = function (tokenName, tokenValue, options) {
          var err = new Error('Failed to save token');
          err.name = 'FailedToSaveTokenError';
          return Promise.reject(err);
        };
        assert.notEqual(client.authToken, null);
        assert.equal(client.authToken.username, 'bob');

        client.authenticate(validSignedAuthTokenKate)
        .then(function (authStatus) {
          assert.notEqual(authStatus, null);
          // The error here comes from the client auth engine and does not prevent the
          // authentication from taking place, it only prevents the token from being
          // stored correctly on the client.
          assert.equal(authStatus.isAuthenticated, true);
          // authError should be null because the error comes from the client-side auth engine
          // whereas authError is for server-side errors (e.g. JWT errors).
          assert.equal(authStatus.authError, null);

          assert.notEqual(client.authToken, null);
          assert.equal(client.authToken.username, 'kate');
          setTimeout(function () {
            assert.notEqual(caughtError, null);
            assert.equal(caughtError.name, 'FailedToSaveTokenError');
            client.auth.saveToken = oldSaveTokenFunction;
            done();
          }, 10);
        });
      });
    });

    it('Should gracefully handle authenticate abortion due to disconnection', function (done) {
      client = socketClusterClient.create(clientOptions);

      client.once('connect', function (statusA) {
        client.authenticate(validSignedAuthTokenBob)
        .catch(function (err) {
          assert.notEqual(err, null);
          assert.equal(err.name, 'BadConnectionError');
          assert.equal(client.authState, 'unauthenticated');
          done();
        });
        client.disconnect();
      });
    });

    it('Should go through the correct sequence of authentication state changes when dealing with disconnections; part 1', function (done) {
      client = socketClusterClient.create(clientOptions);

      var expectedAuthStateChanges = [
        'unauthenticated->authenticated'
      ];
      var authStateChanges = [];
      client.on('authStateChange', (status) => {
        authStateChanges.push(status.oldState + '->' + status.newState);
      });

      assert.equal(client.authState, 'unauthenticated');

      client.once('connect', (statusA) => {
        client.once('authenticate', (newSignedToken) => {
          client.once('disconnect', () => {
            assert.equal(client.authState, 'authenticated');
            client.authenticate(newSignedToken)
            .then((newSignedToken) => {
              assert.equal(client.authState, 'authenticated');
              assert.equal(JSON.stringify(authStateChanges), JSON.stringify(expectedAuthStateChanges));
              client.off('authStateChange');
              done();
            });
            assert.equal(client.authState, 'authenticated');
          });
          assert.equal(client.authState, 'authenticated');
          // In case of disconnection, the socket maintains the last known auth state.
          assert.equal(client.authState, 'authenticated');
        });
        assert.equal(client.authState, 'unauthenticated');
        client.invoke('login', {username: 'bob'})
        .then(() => {
          client.disconnect();
        });
        assert.equal(client.authState, 'unauthenticated');
      });
    });

    it('Should go through the correct sequence of authentication state changes when dealing with disconnections; part 2', function (done) {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);
      client = socketClusterClient.create(clientOptions);

      var expectedAuthStateChanges = [
        'unauthenticated->authenticated',
        'authenticated->unauthenticated',
        'unauthenticated->authenticated',
        'authenticated->unauthenticated'
      ];
      var authStateChanges = [];
      client.on('authStateChange', (status) => {
        authStateChanges.push(status.oldState + '->' + status.newState);
      });

      assert.equal(client.authState, 'unauthenticated');

      client.once('connect', (statusA) => {
        assert.equal(client.authState, 'authenticated');
        client.deauthenticate();
        assert.equal(client.authState, 'unauthenticated');
        client.authenticate(validSignedAuthTokenBob)
        .then(() => {
          assert.equal(client.authState, 'authenticated');
          client.once('disconnect', () => {
            assert.equal(client.authState, 'authenticated');
            client.deauthenticate();
            assert.equal(client.authState, 'unauthenticated');
            assert.equal(JSON.stringify(authStateChanges), JSON.stringify(expectedAuthStateChanges));
            done();
          });
          client.disconnect();
        });
        assert.equal(client.authState, 'unauthenticated');
      });
    });

    it('Should go through the correct sequence of authentication state changes when dealing with disconnections; part 3', function (done) {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);
      client = socketClusterClient.create(clientOptions);

      var expectedAuthStateChanges = [
        'unauthenticated->authenticated',
        'authenticated->unauthenticated'
      ];
      var authStateChanges = [];
      client.on('authStateChange', (status) => {
        authStateChanges.push(status.oldState + '->' + status.newState);
      });

      assert.equal(client.authState, 'unauthenticated');

      client.once('connect', (statusA) => {
        assert.equal(client.authState, 'authenticated');
        client.authenticate(invalidSignedAuthToken)
        .catch((err) => {
          assert.notEqual(err, null);
          assert.equal(err.name, 'AuthTokenInvalidError');
          assert.equal(client.authState, 'unauthenticated');
          assert.equal(JSON.stringify(authStateChanges), JSON.stringify(expectedAuthStateChanges));
          done();
        });
        assert.equal(client.authState, 'authenticated');
      });
    });

    it('Should go through the correct sequence of authentication state changes when authenticating as a user while already authenticated as another user', function (done) {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);
      client = socketClusterClient.create(clientOptions);

      var expectedAuthStateChanges = [
        'unauthenticated->authenticated'
      ];
      var authStateChanges = [];
      client.on('authStateChange', function (status) {
        authStateChanges.push(status.oldState + '->' + status.newState);
      });

      var expectedAuthTokenChanges = [
        validSignedAuthTokenBob,
        validSignedAuthTokenKate
      ];
      var authTokenChanges = [];
      client.on('authenticate', function () {
        authTokenChanges.push(client.signedAuthToken);
      });
      client.on('deauthenticate', function () {
        authTokenChanges.push(client.signedAuthToken);
      });

      assert.equal(client.authState, 'unauthenticated');

      client.once('connect', function (statusA) {
        assert.equal(client.authState, 'authenticated');
        assert.equal(client.authToken.username, 'bob');
        client.authenticate(validSignedAuthTokenKate)
        .then(function () {
          assert.equal(client.authState, 'authenticated');
          assert.equal(client.authToken.username, 'kate');
          assert.equal(JSON.stringify(authStateChanges), JSON.stringify(expectedAuthStateChanges));
          assert.equal(JSON.stringify(authTokenChanges), JSON.stringify(expectedAuthTokenChanges));
          done();
        });
        assert.equal(client.authState, 'authenticated');
      });
    });

    it('Should wait for socket to be authenticated before subscribing to waitForAuth channel', function (done) {
      client = socketClusterClient.create(clientOptions);
      var privateChannel = client.subscribe('priv', {waitForAuth: true});
      assert.equal(privateChannel.state, 'pending');

      client.once('connect', function (statusA) {
        assert.equal(privateChannel.state, 'pending');
        privateChannel.once('subscribe', function () {
          assert.equal(privateChannel.state, 'subscribed');
          client.once('disconnect', function () {
            assert.equal(privateChannel.state, 'pending');
            privateChannel.once('subscribe', function () {
              assert.equal(privateChannel.state, 'subscribed');
              done();
            });
            client.authenticate(validSignedAuthTokenBob);
          });
          client.disconnect();
        });
        client.invoke('login', {username: 'bob'});
      });
    });

    it('Subscriptions (including those with waitForAuth option) should have priority over the authenticate action', function (done) {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);
      client = socketClusterClient.create(clientOptions);

      var expectedAuthStateChanges = [
        'unauthenticated->authenticated',
        'authenticated->unauthenticated'
      ];
      var initialSignedAuthToken;
      var authStateChanges = [];
      client.on('authStateChange', (status) => {
        authStateChanges.push(status.oldState + '->' + status.newState);
      });

      client.authenticate(invalidSignedAuthToken)
      .then(() => {
        return null;
      })
      .catch((err) => {
        return err;
      })
      .then((err) => {
        assert.notEqual(err, null);
        assert.equal(err.name, 'AuthTokenInvalidError');
      });

      var privateChannel = client.subscribe('priv', {waitForAuth: true});
      assert.equal(privateChannel.state, 'pending');

      client.once('connect', (statusA) => {
        initialSignedAuthToken = client.signedAuthToken;
        assert.equal(statusA.isAuthenticated, true);
        assert.equal(privateChannel.state, 'pending');
        privateChannel.once('subscribeFail', (err) => {
          // This shouldn't happen because the subscription should be
          // processed before the authenticate() call with the invalid token fails.
          throw new Error('Failed to subscribe to channel: ' + err.message);
        });
        privateChannel.once('subscribe', (err) => {
          assert.equal(privateChannel.state, 'subscribed');
        });
      });

      client.once('deauthenticate', (oldSignedToken) => {
        // The subscription already went through so it should still be subscribed.
        assert.equal(privateChannel.state, 'subscribed');
        assert.equal(client.authState, 'unauthenticated');
        assert.equal(client.authToken, null);
        assert.equal(oldSignedToken, initialSignedAuthToken);

        var privateChannel2 = client.subscribe('priv2', {waitForAuth: true});
        privateChannel2.once('subscribe', () => {
          throw new Error('Should not subscribe because the socket is not authenticated');
        });
      });

      setTimeout(() => {
        client.off('authStateChange');
        assert.equal(JSON.stringify(authStateChanges), JSON.stringify(expectedAuthStateChanges));
        done();
      }, 1000);
    });

    it('Should trigger the close event if the socket disconnects in the middle of the handshake phase', function (done) {
      client = socketClusterClient.create(clientOptions);
      var aborted = false;
      var diconnected = false;
      var closed = false;

      client.on('connectAbort', function () {
        aborted = true;
      });
      client.on('disconnect', function () {
        diconnected = true;
      });
      client.on('close', function () {
        closed = true;
      });

      client.disconnect();

      setTimeout(function () {
        assert.equal(aborted, true);
        assert.equal(diconnected, false);
        assert.equal(closed, true);
        done();
      }, 300);
    });

    it('Should trigger the close event if the socket disconnects after the handshake phase', function (done) {
      client = socketClusterClient.create(clientOptions);
      var aborted = false;
      var diconnected = false;
      var closed = false;

      client.on('connectAbort', function () {
        aborted = true;
      });
      client.on('disconnect', function () {
        diconnected = true;
      });
      client.on('close', function () {
        closed = true;
      });

      client.on('connect', function () {
        client.disconnect();
      });

      setTimeout(function () {
        assert.equal(aborted, false);
        assert.equal(diconnected, true);
        assert.equal(closed, true);
        done();
      }, 300);
    });
  });

  describe('Emitting remote events', function () {
    it('Should not throw error on socket if ackTimeout elapses before response to event is sent back', function (done) {
      client = socketClusterClient.create(clientOptions);

      var caughtError;

      var clientError;
      client.on('error', (err) => {
        clientError = err;
      });

      var responseError;

      client.on('connect', () => {
        client.invoke('performTask', 123)
        .catch((err) => {
          responseError = err;
        });
        setTimeout(() => {
          try {
            client.disconnect();
          } catch (e) {
            caughtError = e;
          }
        }, 250);
      });

      setTimeout(() => {
        assert.notEqual(responseError, null);
        assert.equal(caughtError, null);
        done();
      }, 300);
    });
  });

  describe('Reconnecting socket', function () {
    it('Should disconnect socket with code 1000 and reconnect', function (done) {
      client = socketClusterClient.create(clientOptions);

      client.once('connect', function () {
        var disconnectCode;
        var disconnectReason;
        client.once('disconnect', function (code, reason) {
          disconnectCode = code;
          disconnectReason = reason;
        });
        client.once('connect', function () {
          assert.equal(disconnectCode, 1000);
          assert.equal(disconnectReason, undefined);
          done();
        });
        client.reconnect();
      });
    });

    it('Should disconnect socket with custom code and data when socket.reconnect() is called with arguments', function (done) {
      client = socketClusterClient.create(clientOptions);

      client.once('connect', function () {
        var disconnectCode;
        var disconnectReason;
        client.once('disconnect', function (code, reason) {
          disconnectCode = code;
          disconnectReason = reason;
        });
        client.once('connect', function () {
          assert.equal(disconnectCode, 1000);
          assert.equal(disconnectReason, 'About to reconnect');
          done();
        });
        client.reconnect(1000, 'About to reconnect');
      });
    });
  });

  describe('Destroying socket', function () {
    it('Should disconnect socket when socket.destroy() is called', function (done) {
      client = socketClusterClient.create(clientOptions);

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      client.on('connect', function () {
        client.destroy();
      });

      client.on('disconnect', function () {
        done();
      });
    });

    it('Should disconnect socket with custom code and data when socket.destroy() is called with arguments', function (done) {
      client = socketClusterClient.create(clientOptions);

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      client.on('connect', function () {
        client.destroy(4321, 'Custom disconnect reason');
      });

      client.on('disconnect', function (code, reason) {
        assert.equal(code, 4321);
        assert.equal(reason, 'Custom disconnect reason');
        done();
      });
    });

    it('Should destroy all references of socket when socket.destroy() is called before connect', function (done) {
      client = socketClusterClient.create(clientOptions);

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      var connectAbortTriggered = false;
      var disconnectTriggered = false;
      var closeTriggered = false;

      client.on('connectAbort', function (n) {
        connectAbortTriggered = true;
      });

      client.on('disconnect', function (n) {
        disconnectTriggered = true;
      });

      client.on('close', function (n) {
        closeTriggered = true;
      });

      assert.equal(Object.keys(socketClusterClient.clients).length, 1);
      assert.equal(socketClusterClient.clients[client.clientId] === client, true);

      client.destroy();

      assert.equal(Object.keys(socketClusterClient.clients).length, 0);
      assert.equal(socketClusterClient.clients[client.clientId], null);
      assert.equal(connectAbortTriggered, true);
      assert.equal(disconnectTriggered, false);
      assert.equal(closeTriggered, true);
      done();
    });

    it('Should destroy all references of socket when socket.destroy() is called after connect', function (done) {
      client = socketClusterClient.create(clientOptions);

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      var connectAbortTriggered = false;
      var disconnectTriggered = false;
      var closeTriggered = false;

      client.on('connectAbort', function (n) {
        connectAbortTriggered = true;
      });

      client.on('disconnect', function (n) {
        disconnectTriggered = true;
      });

      client.on('close', function (n) {
        closeTriggered = true;
      });

      assert.equal(Object.keys(socketClusterClient.clients).length, 1);
      assert.equal(socketClusterClient.clients[client.clientId] === client, true);

      client.on('connect', function () {
        client.destroy();
        assert.equal(Object.keys(socketClusterClient.clients).length, 0);
        assert.equal(socketClusterClient.clients[client.clientId], null);
        assert.equal(connectAbortTriggered, false);
        assert.equal(disconnectTriggered, true);
        assert.equal(closeTriggered, true);
        done();
      });
    });

    it('Should destroy all references of multiplexed socket when socket.destroy() is called', function (done) {
      clientOptions.multiplex = true;
      var clientA = socketClusterClient.create(clientOptions);
      var clientB = socketClusterClient.create(clientOptions);

      var clientAError;
      clientA.on('error', function (err) {
        clientAError = err;
      });

      var clientBError;
      clientB.on('error', function (err) {
        clientBError = err;
      });

      assert.equal(clientA, clientB);

      assert.equal(Object.keys(socketClusterClient.clients).length, 1);
      assert.equal(socketClusterClient.clients[clientA.clientId] === clientA, true);

      clientA.destroy();

      assert.equal(Object.keys(socketClusterClient.clients).length, 0);
      assert.equal(socketClusterClient.clients[clientA.clientId], null);
      done();
    });

    it('Should destroy all references of socket when socketClusterClient.destroy(socket) is called', function (done) {
      client = socketClusterClient.create(clientOptions);

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      assert.equal(Object.keys(socketClusterClient.clients).length, 1);
      assert.equal(socketClusterClient.clients[client.clientId] === client, true);

      socketClusterClient.destroy(client);

      assert.equal(Object.keys(socketClusterClient.clients).length, 0);
      assert.equal(socketClusterClient.clients[client.clientId], null);
      done();
    });

    it('Should destroy all references of socket when socketClusterClient.destroy(socket) is called if the socket was created with query parameters', function () {
      var clientOptionsB = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: true,
        ackTimeout: 200,
        query: {foo: 123, bar: 456}
      };

      var clientA = socketClusterClient.create(clientOptionsB);

      var clientOptionsB = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: true,
        ackTimeout: 200,
        query: {foo: 123, bar: 789}
      };

      var clientB = socketClusterClient.create(clientOptionsB);

      var clientOptionsB2 = {
        hostname: '127.0.0.1',
        port: portNumber,
        multiplex: true,
        ackTimeout: 200,
        query: {foo: 123, bar: 789}
      };

      var clientB2 = socketClusterClient.create(clientOptionsB2);

      return Promise.all([
        new Promise(function (resolve) {
          clientA.on('connect', function () {
            resolve();
          });
        }),
        new Promise(function (resolve) {
          clientB.on('connect', function () {
            resolve();
          });
        }),
        new Promise(function (resolve) {
          clientB2.on('connect', function () {
            resolve();
          });
        })
      ]).then(function () {
        assert.equal(Object.keys(socketClusterClient.clients).length, 2);
        clientA.destroy();
        assert.equal(Object.keys(socketClusterClient.clients).length, 1);
        clientB.destroy();
        assert.equal(Object.keys(socketClusterClient.clients).length, 0);
      });
    });
  });

  describe('Order of events', function () {
    it('Should trigger unsubscribe event on channel before disconnect event', function (done) {
      client = socketClusterClient.create(clientOptions);
      var hasUnsubscribed = false;

      var fooChannel = client.subscribe('foo');
      fooChannel.on('subscribe', function () {
        setTimeout(function () {
          client.disconnect();
        }, 100);
      });
      fooChannel.on('unsubscribe', function () {
        hasUnsubscribed = true;
      });
      client.on('disconnect', function () {
        assert.equal(hasUnsubscribed, true);
        done();
      });
    });

    it('Should not invoke subscribeFail event if connection is aborted', function (done) {
      client = socketClusterClient.create(clientOptions);
      var hasSubscribeFailed = false;
      var gotBadConnectionError = false;

      client.on('connect', () => {
        client.invoke('someEvent', 123)
        .catch((err) => {
          if (err && err.name === 'BadConnectionError') {
            gotBadConnectionError = true;
          }
        });

        var fooChannel = client.subscribe('foo');

        fooChannel.on('subscribeFail', () => {
          hasSubscribeFailed = true;
        });

        client.on('close', () => {
          setTimeout(() => {
            assert.equal(gotBadConnectionError, true);
            assert.equal(hasSubscribeFailed, false);
            done();
          }, 100);
        });

        setTimeout(() => {
          client.disconnect();
        }, 0);
      });
    });

    it('Should resolve invoke Promise with BadConnectionError after triggering the disconnect event', function (done) {
      client = socketClusterClient.create(clientOptions);
      var messageList = [];

      client.on('connect', () => {
        client.disconnect();

        setTimeout(() => {
          assert.equal(messageList.length, 2);
          assert.equal(messageList[0].type, 'disconnect');
          assert.equal(messageList[1].type, 'error');
          assert.equal(messageList[1].error.name, 'BadConnectionError');
          done();
        }, 200);
      });

      client.invoke('someEvent', 123)
      .catch((err) => {
        if (err) {
          messageList.push({
            type: 'error',
            error: err
          });
        }
      });

      client.on('disconnect', (code, reason) => {
        messageList.push({
          type: 'disconnect',
          code: code,
          reason: reason
        });
      });
    });

    it('Should reconnect if transmit is called on a disconnected socket', function (done) {
      var fooEventTriggered = false;
      server.on('connection', function (socket) {
        socket.on('foo', function () {
          fooEventTriggered = true;
        });
      });

      client = socketClusterClient.create(clientOptions);

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      var eventList = [];

      client.on('connecting', function () {
        eventList.push('connecting');
      });
      client.on('connect', function () {
        eventList.push('connect');
      });
      client.on('disconnect', function () {
        eventList.push('disconnect');
      });
      client.on('close', function () {
        eventList.push('close');
      });
      client.on('connectAbort', function () {
        eventList.push('connectAbort');
      });

      client.once('connect', function () {
        client.disconnect();
        client.transmit('foo', 123);
      });

      setTimeout(function () {
        var expectedEventList = ['connect', 'disconnect', 'close', 'connecting', 'connect'];
        assert.equal(JSON.stringify(eventList), JSON.stringify(expectedEventList));
        assert.equal(fooEventTriggered, true);
        done();
      }, 1000);
    });

    it('Should emit an error event if transmit is called on a destroyed socket', function (done) {
      client = socketClusterClient.create(clientOptions);
      assert.equal(client.active, true);

      var disconnectTriggered = false;
      var secondConnectTriggered = false;
      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      client.once('connect', function () {
        assert.equal(client.active, true);

        client.once('disconnect', function () {
          disconnectTriggered = true;
          assert.equal(client.active, false);
        });

        client.destroy();
        assert.equal(client.active, false);

        client.once('connect', function () {
          secondConnectTriggered = true;
        });

        client.transmit('foo', 123)
        .then(() => {
          return null;
        })
        .catch((err) => {
          return err;
        })
        .then((err) => {
          assert.notEqual(err, null);
          assert.equal(err.name, 'InvalidActionError');
        });

        assert.equal(client.active, false);
        assert.equal(client.state, client.CLOSED);
      });

      setTimeout(function () {
        assert.equal(secondConnectTriggered, false);
        assert.equal(disconnectTriggered, true);
        assert.notEqual(clientError, null);
        assert.equal(clientError.name, 'InvalidActionError');
        done();
      }, 100);
    });

    it('Should emit an error event if publish is called on a destroyed socket', function (done) {
      client = socketClusterClient.create(clientOptions);
      assert.equal(client.active, true);

      var clientError;
      client.on('error', (err) => {
        clientError = err;
      });

      client.once('connect', () => {
        assert.equal(client.active, true);

        client.destroy();
        assert.equal(client.active, false);

        client.publish('thisIsATestChannel', 123)
        .then(() => {
          return null;
        })
        .catch((err) => {
          return err;
        })
        .then((err) => {
          assert.notEqual(err, null);
          assert.equal(err.name, 'InvalidActionError');
        });

        assert.equal(client.active, false);
        assert.equal(client.state, client.CLOSED);
      });

      setTimeout(() => {
        assert.notEqual(clientError, null);
        assert.equal(clientError.name, 'InvalidActionError');
        done();
      }, 100);
    });

    it('Should correctly handle multiple successive connect and disconnect calls', function (done) {
      client = socketClusterClient.create(clientOptions);

      var eventList = [];

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });
      client.on('connecting', function () {
        eventList.push({
          event: 'connecting'
        });
      });
      client.on('connect', function () {
        eventList.push({
          event: 'connect'
        });
      });
      client.on('connectAbort', function (code, reason) {
        eventList.push({
          event: 'connectAbort',
          code: code,
          reason: reason
        });
      });
      client.on('disconnect', function (code, reason) {
        eventList.push({
          event: 'disconnect',
          code: code,
          reason: reason
        });
      });
      client.on('close', function (code, reason) {
        eventList.push({
          event: 'close',
          code: code,
          reason: reason
        });
      });

      client.disconnect(1000, 'One');
      client.connect();
      client.disconnect(4444, 'Two');
      client.once('connect', function () {
        client.disconnect(4455, 'Three');
      });
      client.connect();

      setTimeout(function () {
        var expectedEventList = [
          {
            event: 'connectAbort',
            code: 1000,
            reason: 'One'
          },
          {
            event: 'close',
            code: 1000,
            reason: 'One'
          },
          {
            event: 'connecting'
          },
          {
            event: 'connectAbort',
            code: 4444,
            reason: 'Two'
          },
          {
            event: 'close',
            code: 4444,
            reason: 'Two'
          },
          {
            event: 'connecting'
          },
          {
            event: 'connect'
          },
          {
            event: 'disconnect',
            code: 4455,
            reason: 'Three'
          },
          {
            event: 'close',
            code: 4455,
            reason: 'Three'
          },
        ];
        assert.equal(JSON.stringify(eventList), JSON.stringify(expectedEventList));
        done();
      }, 200);
    });
  });

  describe('Destroying channels', function () {
    it('Should unsubscribe from a channel if socketClusterClient.destroyChannel(channelName) is called', function (done) {
      client = socketClusterClient.create(clientOptions);

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      var unsubscribeTriggered = false;

      var fooChannel = client.subscribe('foo');
      fooChannel.on('unsubscribe', function () {
        unsubscribeTriggered = true;
      });
      fooChannel.on('subscribe', function () {
        fooChannel.destroy();
      });

      setTimeout(function () {
        assert.equal(unsubscribeTriggered, true);
        done();
      }, 200);
    });

    it('Should not throw an error if socketClusterClient.destroyChannel(channelName) is called for a non-existent channel', function (done) {
      client = socketClusterClient.create(clientOptions);

      var clientError;
      client.on('error', function (err) {
        clientError = err;
      });

      var destroyError;
      try {
        client.destroyChannel('fakeChannel');
      } catch (err) {
        destroyError = err;
      }
      assert.equal(clientError, null);
      assert.equal(destroyError, null);

      done();
    });
  });

  describe('Ping/pong', function () {
    it('Should disconnect if ping is not received before timeout', function (done) {
      clientOptions.ackTimeout = 500;
      client = socketClusterClient.create(clientOptions);

      assert.equal(client.pingTimeout, 500);

      client.on('connect', function () {
        assert.equal(client.transport.pingTimeout, server.options.pingTimeout);
        // Hack to make the client ping independent from the server ping.
        client.transport.pingTimeout = 500;
      });

      var disconnectCode = null;
      var clientError = null;
      client.on('error', function (err) {
        clientError = err;
      });
      client.on('disconnect', function (code) {
        disconnectCode = code;
      });

      setTimeout(function () {
        assert.equal(disconnectCode, 4000);
        assert.notEqual(clientError, null);
        assert.equal(clientError.name, 'SocketProtocolError');
        done();
      }, 1000);
    });

    it('Should not disconnect if ping is not received before timeout when pingTimeoutDisabled is true', function (done) {
      clientOptions.ackTimeout = 500;
      clientOptions.pingTimeoutDisabled = true;
      client = socketClusterClient.create(clientOptions);

      assert.equal(client.pingTimeout, 500);

      var clientError = null;
      client.on('error', function (err) {
        clientError = err;
      });

      setTimeout(function () {
        assert.equal(clientError, null);
        done();
      }, 1000);
    });
  });

  describe('Utilities', function () {
    it('Can encode a string to base64 and then decode it back to utf8', function (done) {
      client = socketClusterClient.create(clientOptions);
      var encodedString = client.encodeBase64('This is a string');
      assert.equal(encodedString, 'VGhpcyBpcyBhIHN0cmluZw==');
      var decodedString = client.decodeBase64(encodedString);
      assert.equal(decodedString, 'This is a string');
      done();
    });
  });
});
