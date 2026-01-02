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
