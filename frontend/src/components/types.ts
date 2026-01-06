export interface Stop {
    id: string | number;
    name: string;
    lat: number;
    lng: number;
}

export interface Vehicle {
    id: string | number;
    route_id: string | null;
    route_name: string | null;
    lat: number | null;
    lng: number | null;
    heading?: number | null;
    color?: string | null;
}

export interface RoutePoint {
    lat: number;
    lng: number;
    stop_id: string | number;
    stop_name: string;
}

export interface RoutePath {
    route_id: string;
    route_name: string | null;
    short_name: string | null;
    color: string | null;
    path: RoutePoint[];
}

export interface NextBusInfo {
    vehicle_id: string | number;
    lat: number;
    lng: number;
    distance_to_boarding_stop_m: number;
    eta_to_origin_stop?: number | null;        // legacy
    eta_to_boarding_stop_s?: number | null;    // explicit wait time
    ride_eta_s?: number | null;                // approx ride time for this segment
    segment_eta_s?: number | null;             // approx wait + ride for this segment
}

export interface TripSegment {
    route_id: string;
    route_name: string | null;
    short_name: string | null;
    color: string | null;
    start_stop: Stop;
    end_stop: Stop;
    stops: Stop[];
    next_bus: NextBusInfo | null;
    polyline?: { lat: number; lng: number }[];
}

export interface TripEndpoint {
    location: { lat: number; lng: number };
    nearest_stop: Stop;
    distance_m: number;
}

export interface TripResponse {
    origin: TripEndpoint;
    destination: TripEndpoint;
    system_id: number;
    segments: TripSegment[];
    error?: string;
}
