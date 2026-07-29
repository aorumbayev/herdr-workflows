import { createServer, type Server, type Socket } from "node:net";
import { resolveHerdrSocketAddress } from "../src/herdr";

/** Listen address matching what `herdrRequest` derives from a marker `HERDR_SOCKET_PATH`. */
export function listenAddressForMarker(markerPath: string): string {
  return resolveHerdrSocketAddress(markerPath);
}

/** Bind a fake Herdr Unix socket for tests. */
export async function listenHerdrSocket(
  markerPath: string,
  onConnection: (socket: Socket) => void,
): Promise<Server> {
  const server = createServer(onConnection);
  const listenPath = listenAddressForMarker(markerPath);
  await new Promise<void>((resolve, reject) => {
    server.listen(listenPath, () => resolve());
    server.on("error", reject);
  });
  return server;
}
