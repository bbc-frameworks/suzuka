
var Suzuka = function () {

    var Suzuka = function (urlPrefix, forceHashTransport) {
        if (! urlPrefix) {
            urlPrefix = '';
        }
        this._proxyUrl = urlPrefix + '/iframeproxy';
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



