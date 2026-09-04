declare module 'tuyapi/lib/message-parser.js' {
  export interface ParsedPacket { payload: unknown }
  export class MessageParser {
    constructor(options: { key: string | Buffer; version: string });
    parse(buffer: Buffer): ParsedPacket[];
  }
  const module: { MessageParser: typeof MessageParser };
  export default module;
}
