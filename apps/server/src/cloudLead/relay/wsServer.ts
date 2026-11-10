/**
 * The smallest WebSocket server the relay needs: text messages, ping/pong and
 * close (RFC 6455). The sandbox relay runs from plain files with no
 * node_modules, so it cannot use a WebSocket package.
 */
// @effect-diagnostics nodeBuiltinImport:off - runs standalone inside the sandbox, outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export interface WsConnection {
  readonly send: (text: string) => void;
  readonly close: () => void;
  onMessage: (text: string) => void;
  onClose: () => void;
}

const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
};

/** Accepts an HTTP upgrade request and returns the connection, or null after refusing it. */
export const acceptWebSocket = (
  request: NodeHttp.IncomingMessage,
  socket: NodeNet.Socket,
  head: Buffer = Buffer.alloc(0),
): WsConnection | null => {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  const accept = NodeCrypto.createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  let closed = false;
  let buffered = Buffer.from(head);
  let fragments: Buffer[] = [];
  const connection: WsConnection = {
    send: (text) => {
      if (!closed) socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        socket.end(encodeFrame(0x8, Buffer.alloc(0)));
      } catch {}
      socket.destroy();
      connection.onClose();
    },
    onMessage: () => {},
    onClose: () => {},
  };

  const fail = () => connection.close();

  const parse = () => {
    while (buffered.length >= 2) {
      const first = buffered[0]!;
      const second = buffered[1]!;
      const opcode = first & 0x0f;
      const fin = (first & 0x80) !== 0;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) return fail();
        length = Number(big);
        offset = 10;
      }
      // Clients must mask every frame (RFC 6455 5.1).
      if (!masked) return fail();
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      buffered = buffered.subarray(offset + 4 + length);

      if (opcode === 0x8) return fail();
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fragments.reduce((sum, part) => sum + part.length, 0) > MAX_MESSAGE_BYTES) {
          return fail();
        }
        if (fin) {
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          connection.onMessage(text);
        }
        continue;
      }
      return fail();
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    parse();
  });
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    connection.onClose();
  });
  socket.on("error", () => fail());
  // Bytes that arrived with the upgrade request; parsed once the caller set onMessage.
  if (buffered.length > 0) setImmediate(parse);

  // Keep idle proxies from dropping the connection.
  const keepAlive = setInterval(() => {
    if (closed) return clearInterval(keepAlive);
    socket.write(encodeFrame(0x9, Buffer.alloc(0)));
  }, 20_000);
  keepAlive.unref();

  return connection;
};
