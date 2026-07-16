/** Thin wrappers around Google Places API (New) and Routes API. */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface PlaceCandidate {
  placeId: string;
  name: string;
  rating?: number;
  ratingCount?: number;
  priceLevel?: string;
  address?: string;
  location: LatLng;
  openNow?: boolean;
  summary?: string;
  types?: string[];
}

export interface DriveEstimate {
  durationMinutes: number;
  distanceKm: number;
}

function apiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not set");
  return key;
}

export async function searchRestaurants(
  query: string,
  near: LatLng,
  opts: { radiusMeters?: number; openNow?: boolean } = {},
): Promise<PlaceCandidate[]> {
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.rating",
        "places.userRatingCount",
        "places.priceLevel",
        "places.formattedAddress",
        "places.location",
        "places.currentOpeningHours.openNow",
        "places.editorialSummary",
        "places.types",
      ].join(","),
    },
    body: JSON.stringify({
      textQuery: query,
      includedType: "restaurant",
      openNow: opts.openNow ?? true,
      maxResultCount: 10,
      locationBias: {
        circle: {
          center: { latitude: near.lat, longitude: near.lng },
          radius: opts.radiusMeters ?? 5000,
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Places search failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as {
    places?: Array<{
      id: string;
      displayName?: { text?: string };
      rating?: number;
      userRatingCount?: number;
      priceLevel?: string;
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
      currentOpeningHours?: { openNow?: boolean };
      editorialSummary?: { text?: string };
      types?: string[];
    }>;
  };
  return (body.places ?? []).map((p) => ({
    placeId: p.id,
    name: p.displayName?.text ?? "Unknown",
    rating: p.rating,
    ratingCount: p.userRatingCount,
    priceLevel: p.priceLevel?.replace("PRICE_LEVEL_", "").toLowerCase(),
    address: p.formattedAddress,
    location: { lat: p.location?.latitude ?? 0, lng: p.location?.longitude ?? 0 },
    openNow: p.currentOpeningHours?.openNow,
    summary: p.editorialSummary?.text,
    types: p.types,
  }));
}

export async function computeDriveEstimate(
  origin: LatLng,
  destinationPlaceId: string,
): Promise<DriveEstimate> {
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { placeId: destinationPlaceId },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    }),
  });
  if (!response.ok) {
    throw new Error(`Routes API failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as {
    routes?: Array<{ duration?: string; distanceMeters?: number }>;
  };
  const route = body.routes?.[0];
  if (!route) throw new Error("Routes API returned no routes");
  return {
    durationMinutes: Math.round(parseInt(route.duration ?? "0", 10) / 60),
    distanceKm: Math.round(((route.distanceMeters ?? 0) / 1000) * 10) / 10,
  };
}

/** Deep link that opens turn-by-turn driving navigation in Google Maps. */
export function mapsDeepLink(origin: LatLng, destinationName: string, destinationPlaceId: string): string {
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: destinationName,
    destination_place_id: destinationPlaceId,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
