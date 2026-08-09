import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

/**
 * Firebase Admin wrapper. CODLOCK uses Firestore for customer risk logs and
 * real-time event analytics (append-heavy, queried by the Risk Scoring Tool).
 *
 * Initialisation is tolerant: if Firebase is not configured in a given
 * environment (e.g. local dev without a key), risk logging degrades to no-ops
 * rather than crashing the whole app.
 */
@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app?: admin.app.App;
  private _enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const projectId = this.config.get<string>('firebase.projectId');
    const clientEmail = this.config.get<string>('firebase.clientEmail');
    const privateKey = this.config.get<string>('firebase.privateKey');
    const databaseUrl = this.config.get<string>('firebase.databaseUrl');

    // Local-dev mode: when the Firestore emulator host is set, the Admin SDK
    // talks to the emulator and needs no real service-account credentials —
    // only a project id.
    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

    if (!projectId || (!emulatorHost && (!clientEmail || !privateKey))) {
      this.logger.warn(
        'Firebase credentials incomplete — risk logging runs in no-op mode.',
      );
      return;
    }

    try {
      const existing = admin.apps.length > 0 ? admin.apps[0] : null;
      if (existing) {
        this.app = existing;
      } else if (emulatorHost) {
        this.app = admin.initializeApp({ projectId });
        this.logger.log(
          `Firebase Admin initialised (emulator @ ${emulatorHost})`,
        );
      } else {
        this.app = admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
          }),
          databaseURL: databaseUrl,
        });
        this.logger.log('Firebase Admin initialised (cloud)');
      }
      this._enabled = true;
    } catch (err) {
      this.logger.error(`Firebase init failed: ${(err as Error).message}`);
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get firestore(): admin.firestore.Firestore | null {
    return this._enabled && this.app ? this.app.firestore() : null;
  }

  /** Append a risk/analytics event. Silently skipped when Firebase is off. */
  async logEvent(
    collection: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const db = this.firestore;
    if (!db) return;
    try {
      await db.collection(collection).add({
        ...payload,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      // Analytics logging must never break the request path.
      this.logger.warn(
        `Failed to log event to ${collection}: ${(err as Error).message}`,
      );
    }
  }
}
