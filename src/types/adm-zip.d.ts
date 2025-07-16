declare module 'adm-zip' {
  export default class AdmZip {
    constructor(file?: string | Buffer);
    getEntries(): Array<{ entryName: string }>;
    readAsText(entry: string): string;
    extractEntryTo(entry: string, targetPath: string, maintainEntryPath?: boolean, overwrite?: boolean): void;
    addLocalFile(localPath: string): void;
    addFile(entryName: string, content: Buffer): void;
    toBuffer(): Buffer;
  }
}
