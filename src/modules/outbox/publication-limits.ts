import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
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
 * The message size the connected NATS server accepts (the kit's
 * `NatsClient.maxPayloadBytes()`, the `max_payload` of its INFO), passed to
 * `enqueueEvent({ maxBytes })` by the zone writes so that a snapshot that
 * could never be published is refused with `422 ZONE_SNAPSHOT_TOO_LARGE`
 * before anything is written. At startup it states whether the server
 * carries the largest zone the input rules allow (about 1.6 MB): the kit
 * warns below the platform's 4 MiB, this line names geo's own need.
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
   * bytes; the NATS default (1 MiB) before the first connection, so an
   * unknown limit never lets a larger snapshot through.
   */
  maxPayloadBytes(): number {
    return this.nats.maxPayloadBytes() ?? NATS_DEFAULT_MAX_PAYLOAD_BYTES;
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
