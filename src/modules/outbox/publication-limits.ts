import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  NatsClient,
  NatsNotConnectedError,
} from '@darmawanweb/ais-its-nest/nats';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { Config } from '../../config.js';
import {
  NATS_DEFAULT_MAX_PAYLOAD_BYTES,
  worstCaseSnapshotPayloadBytes,
} from '../../domain/zone-publication.js';

/**
 * The message size the connected NATS server accepts (`max_payload` of its
 * INFO), read by the zone writes to refuse snapshots that could never be
 * published (`422 ZONE_SNAPSHOT_TOO_LARGE`). At startup it warns when the
 * server cannot carry the largest zone the input rules allow, so operators
 * raise `max_payload` (the platform server uses 4 MB) instead of discovering
 * refused writes later.
 */
@Injectable()
export class PublicationLimits implements OnApplicationBootstrap {
  private readonly logger = new Logger('PublicationLimits');
  private readonly serviceName: string;

  constructor(
    private readonly nats: NatsClient,
    @InjectConfig() config: Config,
  ) {
    this.serviceName = config.SERVICE_NAME;
  }

  /**
   * `max_payload` of the server the client is (or was last) connected to,
   * bytes; the NATS default (1 MiB) before the first connection.
   */
  maxPayloadBytes(): number {
    try {
      return (
        this.nats.connection.info?.max_payload ?? NATS_DEFAULT_MAX_PAYLOAD_BYTES
      );
    } catch (error) {
      if (error instanceof NatsNotConnectedError) {
        return NATS_DEFAULT_MAX_PAYLOAD_BYTES;
      }
      throw error;
    }
  }

  /** Logs the limit once connected; warns when the largest valid zone would not fit. */
  async onApplicationBootstrap(): Promise<void> {
    await this.nats.ready();
    const maxPayloadBytes = this.maxPayloadBytes();
    const neededBytes = worstCaseSnapshotPayloadBytes(this.serviceName);
    if (maxPayloadBytes < neededBytes) {
      this.logger.warn(
        { maxPayloadBytes, neededBytes },
        'NATS max_payload is below the largest valid zone snapshot: larger zones will be refused with 422 ZONE_SNAPSHOT_TOO_LARGE (set max_payload >= 4MB on the server)',
      );
      return;
    }
    this.logger.log(
      { maxPayloadBytes, neededBytes },
      'NATS max_payload carries every valid zone snapshot',
    );
  }
}
