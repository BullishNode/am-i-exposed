"use client";

import { useEffect, useRef } from "react";
import { setSupplementaryEntityChecker } from "@/lib/analysis/entity-filter/entity-match";
import type { EntityMatch } from "@/lib/analysis/entity-filter/types";

/**
 * Fetches custom entity-address mappings from the API server and registers
 * them as a supplementary entity checker. This makes custom entities appear
 * on graph nodes, in entity detection findings, and in chain trace results.
 *
 * Tries to fetch from the same origin at /api/v1/entities/addresses/all.
 * If the server is not running (404 or network error), silently skips.
 *
 * @param serverUrl Optional explicit server URL (e.g., "http://localhost:3001").
 *   If not provided, uses the current page origin.
 */
export function useCustomEntities(serverUrl?: string): void {
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    const baseUrl = serverUrl ?? window.location.origin;
    const url = `${baseUrl}/api/v1/entities/addresses/all`;

    fetch(url, { signal: AbortSignal.timeout(5000) })
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (!data?.addresses || typeof data.addresses !== "object") return;

        const lookup = new Map<string, { entityName: string; category: string }>();
        for (const [addr, info] of Object.entries(data.addresses)) {
          const typed = info as { entityName: string; category: string };
          lookup.set(addr, typed);
        }

        if (lookup.size === 0) return;

        setSupplementaryEntityChecker((address: string): EntityMatch | null => {
          const hit = lookup.get(address);
          if (!hit) return null;
          return {
            address,
            entityName: hit.entityName,
            category: hit.category as EntityMatch["category"],
            ofac: false,
            confidence: "high",
          };
        });

        // eslint-disable-next-line no-console
        console.log(`Loaded ${lookup.size} custom entity addresses from server.`);
      })
      .catch(() => {
        // Server not available — silently skip. Normal for non-server deployments.
      });
  }, [serverUrl]);
}
