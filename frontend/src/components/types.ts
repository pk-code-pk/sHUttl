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

export interface TripSegment {
    route_id: string;
    route_name: string | null;
    short_name: string | null;
    color: string | null;
    start_stop: Stop;
    end_stop: Stop;
    stops: Stop[];
    next_bus: {
        vehicle_id: string | number;
        lat: number;
        lng: number;
        distance_to_origin_stop: number;
        eta_to_origin_stop: number | null;
        eta_to_origin_stop_minutes: number | null;
    } | null;
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
