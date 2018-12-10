function ws(uri, protocols, opts) {
    wx.onSocketOpen(this.handleSocketOpen.bind(this))
    wx.onSocketClose(this.handleSocketClose.bind(this))
    wx.onSocketMessage(this.handleMessage.bind(this))
    wx.onSocketError(this.handleSocketError.bind(this))
    wx.connectSocket({ url: uri })
    return this;
}

ws.prototype = {
    handleSocketOpenLater: function (res) {
        var that = this;
        if (this.handleSocketOpenLaterHandler) {
            clearTimeout(this.handleSocketOpenLaterHandler)
        }

        this.handleSocketOpenLaterHandler = setTimeout(function () {
            that.handleSocketOpen(res);
        }, 1000)
    },
    handleSocketOpen: function (res) {
        if (this.onopen) {
            this.onopen(res)
        } else {
            this.handleSocketOpenLater(res)
        }
    },
    handleMessage: function (res) {
        if (this.onmessage) {
            this.onmessage(res)
        } else {
            this.handleMessageLater(res)
        }
    },
    handleMessageLater: function (res) {
        var that = this;
        if (this.handleMessageLaterHandler) {
            clearTimeout(this.handleMessageLaterHandler)
        }

        this.handleMessageLaterHandler = setTimeout(function () {
            that.handleMessage(res);
        }, 1000)
    },
    handleSocketError: function (res) {
        if (this.onerror) {
            this.onerror(res)
        } else {
            this.handleSocketErrorLater(res)
        }
    },
    handleSocketErrorLater: function (res) {
        var that = this;
        if (this.handleSocketErrorLaterHandler) {
            clearTimeout(this.handleSocketErrorLaterHandler)
        }

        this.handleSocketErrorLaterHandler = setTimeout(function () {
            that.handleSocketError(res);
        }, 1000)
    },
    handleSocketClose: function (res) {
        if (this.onclose) {
            this.onclose(res)
        } else {
            this.handleSocketCloseLater(res)
        }
    },
    handleSocketCloseLater: function (res) {
        var that = this;
        if (this.handleSocketCloseLaterHandler) {
            clearTimeout(this.handleSocketCloseLaterHandler)
        }

        this.handleSocketCloseLaterHandler = setTimeout(function () {
            that.handleSocketClose(res);
        })
    },
    send: function (data) {
        wx.sendSocketMessage({
            data: data, fail: function (res) {
                console.log("wx web socket send failed: " + res)
            }
        })
    },
    close: wx.closeSocket
};

module.exports = ws;