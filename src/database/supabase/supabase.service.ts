import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Thin wrapper around a single, server-side Supabase client using the
 * service-role key. Feature services get the raw client via `.client` and
 * build their own typed queries; `.table()` is a small convenience helper.
 */
@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private _client!: SupabaseClient;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<string>('supabase.url');
    const key = this.config.get<string>('supabase.serviceRoleKey');
    const schema = this.config.get<string>('supabase.schema') ?? 'public';

    if (!url || !key) {
      throw new InternalServerErrorException('Supabase credentials are not configured');
    }

    // `db.schema` accepts a runtime string; the client generic defaults to the
    // "public" literal, so cast to the loose SupabaseClient type on assignment.
    this._client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema },
    }) as unknown as SupabaseClient;
    this.logger.log(`Supabase client initialised (schema="${schema}")`);
  }

  get client(): SupabaseClient {
    return this._client;
  }

  /** Convenience: `supabase.table('orders').select('*')`. */
  table(name: string) {
    return this._client.from(name);
  }

  /**
   * Unwraps a Supabase `{ data, error }` result, throwing on error so the
   * global filter can turn it into a clean 500. Keeps services terse.
   */
  unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
    if (result.error) {
      this.logger.error(`Supabase query failed: ${result.error.message}`);
      throw new InternalServerErrorException('Database operation failed');
    }
    return result.data as T;
  }
}
