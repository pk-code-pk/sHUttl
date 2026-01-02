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
