import type { User } from "@auth/types.ts";
import type { Logger } from "@platform/logger.ts";
import type { Config } from "@platform/config.ts";
import type { Services } from "@web/services.ts";

/** Hono environment: what every handler can count on finding on the context. */
export interface AppEnv {
  Variables: {
    /** Null only on the public routes; the default-deny middleware guarantees it elsewhere. */
    user: User | null;
    csrfToken: string;
    logger: Logger;
    requestId: string;
    clientIp: string;
    config: Config;
    services: Services;
  };
}
