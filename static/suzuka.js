
var Suzuka = function () {

    if ('io' in window) {
        var Suzuka = function (host) {
            this._host = host;
        };

        Suzuka.prototype.subscribe = function (callback) {
            var socket = new io.Socket(this._host, { "transports" : [ "flashsocket", "websocket" ], "rememberTransport" : false });
            socket.on('message', callback);
            socket.on('error', function () {
                alert('error');
            });
            socket.on('connect', function () {

            });
            socket.on('disconnect', function () {
                socket.connect();
            });
            socket.connect();
        };

        return Suzuka;
    }

    var Suzuka = function (host, forceHashTransport) {
        if (! host) {
            host = '';
        }
        this._proxyUrl = host + '/iframeproxy';
        this._forceHashTransport = forceHashTransport;
    };

    Suzuka.prototype.subscribe = function (callback) {
        var iframe = document.createElement('iframe'),
            suzuka = this;
        iframe.setAttribute('style', 'position: absolute; height: 0; visibility: hidden');
        if (! this._forceHashTransport && window.postMessage && window.addEventListener) {
            document.getElementsByTagName('body')[0].appendChild(iframe);
            iframe.setAttribute('src', this._proxyUrl);
            window.addEventListener('message', function (e) {
                callback(e.data);
            }, false);
        }
        else {
            document.getElementsByTagName('body')[0].appendChild(iframe);
            var iframeWindow = iframe.contentWindow;
            iframeWindow.document.open();
            iframeWindow.document.write(
                '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8" /></head><body><iframe src="' + this._proxyUrl + '#hash-transport" id="iframe"></iframe></body></html>'
            );
            iframeWindow.document.close();
            iframeWindow.location.hash = 'waiting';
            setInterval(function () {
                var hash = (iframeWindow.location.href.split('#')[1] || '');
                if (hash !== 'waiting') {
                    callback(decodeURIComponent(hash));
                    iframeWindow.location.hash = 'waiting';
                }
            }, 40);
        }
    };

    return Suzuka;
}();



