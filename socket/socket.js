var wget = require('../wget');

module.exports = (io) => {
  io.on('connection', function (socket) {
    socket.on('request', function (data) {
      if (!data || typeof data.token !== 'string' || !data.token) return;

      // The handle returned by wget() is now stored on the socket. It never was
      // before, so the cleanup below could never find a process to stop.
      if (socket.job) {
        socket.emit(data.token, { error: 'A download is already running on this connection.' });
        return;
      }

      console.log('Request connection received %s', data.token);
      socket.job = wget(socket, data, function () {
        socket.job = null;
      });
    });

    socket.on('disconnect', function () {
      console.log('User disconnected');
      // Stop the wget process and remove partially downloaded files
      if (socket.job) {
        socket.job.cancel();
        socket.job = null;
      }
    });
  });
};
