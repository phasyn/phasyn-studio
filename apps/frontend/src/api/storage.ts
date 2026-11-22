// Storage cleanup (x-phasyn-extension): usage, dry-run plans, the deletion of the listed items and the pins.
// Every write is sent once and never retried (a lost answer is resolved by planning again: deleted items are gone).
import { useQuery } from "@tanstack/react-query";
import type { StorageCleanRequest, StorageCleanResult, StoragePins, StoragePinsRequest, StorageUsage } from "./generated/contracts";
import { contractJson } from "./http";

export const storageKeys = {
  all: () => ["storage"] as const,
  usage: () => ["storage", "usage"] as const,
  pins: () => ["storage", "pins"] as const,
};

export function fetchStorageUsage(signal?: AbortSignal): Promise<StorageUsage> {
  return contractJson("StorageUsage", "/api/storage", { signal });
}

/** Disk usage, reclaimable space and per-project media; read on demand (it scans every store and node). */
export function useStorageUsage() {
  return useQuery({
    queryKey: storageKeys.usage(),
    queryFn: ({ signal }) => fetchStorageUsage(signal),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** A dry run (`dry_run: true`) or the deletion of `items` (only those still eligible are touched). */
export function cleanStorage(body: StorageCleanRequest): Promise<StorageCleanResult> {
  return contractJson("StorageCleanResult", "/api/storage/clean", { method: "POST", json: body });
}

export function fetchStoragePins(signal?: AbortSignal): Promise<StoragePins> {
  return contractJson("StoragePins", "/api/storage/pins", { signal });
}

export function useStoragePins() {
  return useQuery({ queryKey: storageKeys.pins(), queryFn: ({ signal }) => fetchStoragePins(signal), retry: false });
}

export function updateStoragePins(body: StoragePinsRequest): Promise<StoragePins> {
  return contractJson("StoragePins", "/api/storage/pins", { method: "POST", json: body });
}
