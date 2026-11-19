import { Socket } from 'node:net';

type SocketWithTypeOfService = Socket & {
  setTypeOfService?: (this: Socket, value: number) => Socket;
};

export function guardMacSocketTypeOfService(platform = process.platform): void {
  if (platform !== 'darwin') return;
  const prototype: SocketWithTypeOfService = Socket.prototype;
  const setTypeOfService = prototype.setTypeOfService;
  if (!setTypeOfService) return;

  // Electron's bundled Undici can throw outside the fetch promise when macOS
  // rejects its default QoS mark. An ordinary request can still use the socket.
  // https://github.com/nodejs/undici/pull/5547
  prototype.setTypeOfService = function (value) {
    try { return setTypeOfService.call(this, value); }
    catch (error) {
      const cause = error as NodeJS.ErrnoException | undefined;
      if (value === 0 && cause?.code === 'EINVAL' && cause.syscall === 'setTypeOfService') return this;
      throw error;
    }
  };
}
