import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** A PostgREST/PostgreSQL error carries the SQLSTATE in `code`. */
interface PostgrestError {
  message: string;
  code?: string;
  details?: string;
}

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
      throw new InternalServerErrorException(
        'Supabase credentials are not configured',
      );
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
   * Unwraps a Supabase `{ data, error }` result, throwing on error. Known
   * client-caused constraint violations are mapped to the right 4xx so callers
   * get an actionable status instead of a blanket 500; everything else stays a
   * 500 with the detail confined to the server log.
   */
  unwrap<T>(result: { data: T | null; error: PostgrestError | null }): T {
    if (result.error) {
      throw this.toHttpError(result.error);
    }
    return result.data as T;
  }

  /**
   * Translates a PostgreSQL SQLSTATE into an HTTP exception.
   *   23505 unique_violation      → 409 Conflict
   *   23503 foreign_key_violation → 400 Bad Request
   *   23514 check_violation       → 400 Bad Request
   * The raw driver message (which can leak column/constraint internals) is
   * logged, never returned to the client.
   */
  private toHttpError(error: PostgrestError): Error {
    this.logger.error(
      `Supabase query failed [${error.code ?? 'n/a'}]: ${error.message}`,
    );
    switch (error.code) {
      case '23505':
        return new ConflictException('Resource already exists');
      case '23503':
        return new BadRequestException('Referenced resource does not exist');
      case '23514':
        return new BadRequestException(
          'A field failed a validation constraint',
        );
      default:
        return new InternalServerErrorException('Database operation failed');
    }
  }
}
