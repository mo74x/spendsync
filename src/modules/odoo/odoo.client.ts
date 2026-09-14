import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as xmlrpc from 'xmlrpc';

@Injectable()
export class OdooClient implements OnModuleInit {
  private readonly logger = new Logger(OdooClient.name);
  private commonClient: xmlrpc.Client;
  private objectClient: xmlrpc.Client;
  private uid: number;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const host = this.config.get<string>('ODOO_HOST');
    const port = this.config.get<number>('ODOO_PORT');

    // Odoo exposes two main endpoints: 'common' (for auth) and 'object' (for data)
    this.commonClient = xmlrpc.createClient({
      host,
      port,
      path: '/xmlrpc/2/common',
    });
    this.objectClient = xmlrpc.createClient({
      host,
      port,
      path: '/xmlrpc/2/object',
    });
  }

  // Authenticate to get the user ID
  private async authenticate(): Promise<number> {
    if (this.uid) return this.uid; // Cache the UID

    const db = this.config.get<string>('ODOO_DB');
    const username = this.config.get<string>('ODOO_USERNAME');
    const password = this.config.get<string>('ODOO_PASSWORD');

    return new Promise<number>((resolve, reject) => {
      this.commonClient.methodCall(
        'authenticate',
        [db, username, password, {}],
        (error, value) => {
          if (error || !value) {
            this.logger.error('Odoo Authentication Failed. Check credentials.');
            return reject(this.toError(error, 'Authentication returned false'));
          }
          this.uid = value as number;
          resolve(this.uid);
        },
      );
    });
  }

  // The core ORM execution wrapper
  public async executeKw<T = unknown>(
    model: string,
    method: string,
    args: any[],
    kwargs: any = {},
  ): Promise<T> {
    const uid = await this.authenticate();
    const db = this.config.get<string>('ODOO_DB');
    const password = this.config.get<string>('ODOO_PASSWORD');

    return new Promise<T>((resolve, reject) => {
      this.objectClient.methodCall(
        'execute_kw',
        [db, uid, password, model, method, args, kwargs],
        (error, value) => {
          if (error) {
            return reject(this.toError(error, 'Odoo execution failed'));
          }
          resolve(value as T);
        },
      );
    });
  }

  private toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }
    if (typeof error === 'string') {
      return new Error(error);
    }
    if (error && typeof error === 'object') {
      const errObj = error as Record<string, unknown>;
      if (typeof errObj.faultString === 'string') {
        return new Error(`XML-RPC fault: ${errObj.faultString}`);
      }
      if (typeof errObj.message === 'string') {
        return new Error(errObj.message);
      }
      try {
        const json = JSON.stringify(errObj);
        if (json !== '{}') {
          return new Error(json);
        }
      } catch {
        return new Error(fallbackMessage);
      }
    }
    return new Error(fallbackMessage);
  }

  // Helper: Convert our string account codes to Odoo's internal integer IDs
  public async getAccountIdByCode(code: string): Promise<number> {
    const records = await this.executeKw<Array<{ id: number }>>(
      'account.account',
      'search_read',
      [[['code', '=', code]]],
      {
        fields: ['id'],
        limit: 1,
      },
    );

    if (!records || records.length === 0) {
      throw new Error(
        `Account Code ${code} not found in Odoo Chart of Accounts.`,
      );
    }
    return records[0].id;
  }

  // Helper: Convert our string analytic account code or name to Odoo's internal integer ID
  public async getAnalyticAccountIdByCode(code: string): Promise<number> {
    const records = await this.executeKw<Array<{ id: number }>>(
      'account.analytic.account',
      'search_read',
      [['|', ['code', '=', code], ['name', '=', code]]],
      {
        fields: ['id'],
        limit: 1,
      },
    );

    if (!records || records.length === 0) {
      throw new Error(
        `Analytic Account Code '${code}' not found in Odoo Analytic Accounts.`,
      );
    }
    return records[0].id;
  }
}
