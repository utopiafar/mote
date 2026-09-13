// A non-secret marker allows the existing central UI to use native authentication.
// The actual token is injected only for same-origin API requests by the main process.
window.sessionStorage.setItem('mote.connection', JSON.stringify({ url: window.location.origin, token: '__MOTE_NATIVE_AUTH__' }));
