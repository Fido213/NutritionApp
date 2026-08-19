declare module 'sql.js' {
  export interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    getAsObject(): any;
    free(): boolean;
  }

  export class Database {
    constructor(data?: Uint8Array | null);
    run(sql: string, params?: any[]): Database;
    exec(sql: string): Array<{ columns: string[]; values: any[][] }>;
    prepare(sql: string): Statement;
    getRowsModified(): number;
    close(): void;
    export(): Uint8Array;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}