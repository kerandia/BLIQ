/**
 * Sync Places helpers for the Vapi tool webhook (`POST /api/tools`).
 * Must stay fast — Vapi times out around ~7.5s.
 */

import { type LatLng, searchRestaurants } from "./googlemaps.js";

export interface NearbyRestaurant {
  place_id: string;
  name: string;
  rating: number;
  distance_m: number;
  cuisine: string;
}

export interface RestaurantInfo {
  place_id: string;
  name: string;
  rating: number;
  open_now: boolean;
  hours: string;
  cuisine: string;
  address: string;
}

function apiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not set");
  return key;
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function cuisineFromTypes(types?: string[]): string {
  if (!types?.length) return "restaurant";
  const skip = new Set(["restaurant", "food", "point_of_interest", "establishment"]);
  const hit = types.find((t) => !skip.has(t));
  return (hit ?? "restaurant").replace(/_/g, " ");
}

/** Nearby restaurants for the voice assistant — keep ≤5 for LLM context. */
export async function findNearbyRestaurants(
  lat: number,
  lng: number,
  radius: number = 1500,
): Promise<NearbyRestaurant[]> {
  const origin = { lat, lng };
  const places = await searchRestaurants("restaurant", origin, {
    radiusMeters: radius,
    openNow: false,
  });

  return places
    .slice(0, 5)
    .map((p) => ({
      place_id: p.placeId,
      name: p.name,
      rating: p.rating ?? 0,
      distance_m: haversineMeters(origin, p.location),
      cuisine: cuisineFromTypes(p.types),
    }))
    .sort((a, b) => a.distance_m - b.distance_m);
}

/** Place details — hours kept short so they can be read aloud. */
export async function getRestaurantInfo(placeId: string): Promise<RestaurantInfo> {
  // Places API (New) resource names are `places/{id}`; agents sometimes pass bare ids.
  const name = placeId.startsWith("places/") ? placeId : `places/${placeId}`;
  const response = await fetch(`https://places.googleapis.com/v1/${name}`, {
    headers: {
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": [
        "id",
        "displayName",
        "rating",
        "formattedAddress",
        "primaryTypeDisplayName",
        "types",
        "currentOpeningHours.openNow",
        "currentOpeningHours.weekdayDescriptions",
      ].join(","),
    },
  });
  if (!response.ok) {
    throw new Error(`Place details failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as {
    id?: string;
    displayName?: { text?: string };
    rating?: number;
    formattedAddress?: string;
    primaryTypeDisplayName?: { text?: string };
    types?: string[];
    currentOpeningHours?: {
      openNow?: boolean;
      weekdayDescriptions?: string[];
    };
  };

  const todayHours = body.currentOpeningHours?.weekdayDescriptions?.[0] ?? "hours unknown";

  return {
    place_id: body.id ?? placeId,
    name: body.displayName?.text ?? "Unknown",
    rating: body.rating ?? 0,
    open_now: body.currentOpeningHours?.openNow ?? false,
    hours: todayHours,
    cuisine: body.primaryTypeDisplayName?.text ?? cuisineFromTypes(body.types),
    address: body.formattedAddress ?? "",
  };
}
