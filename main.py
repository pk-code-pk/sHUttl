from fastapi import FastAPI
import math 
from passio_cilent import get_stops, get_vehicles, get_routes 
app = FastAPI() 
#intialize our app with FastAPI framework 
@app.get("/health")
#test health of our api endpoint  
def health_check():
    return {"status": "ok", "message": "Backend is running!"}



def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:

## using haversine to calc distance between two sets of latitudes and longitudes 

    R = 6371000 ## earth rad. 
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)

    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2 
    )   

    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c 






def stopdict(stop):
#takes list of stops and turns it into json data 
    return{
        "id": stop.id, 
        "name": stop.name,
        "lat": stop.latitude,
        "lng": stop.longitude,
    }

def vehicledict(vehicle):
    lat = getattr(vehicle, "latitude", None) 
    lng = getattr(vehicle, "longitude", None) 
    floatlat = float(lat) if lat else None
    floatlng = float(lng) if lng else None


    return {
        "id": vehicle.id,
        "route_id": getattr(vehicle, "routeId", None),
        "route_name": getattr(vehicle, "routeName", None),
        "lat": floatlat,
        "lng": floatlng, 
        
    }



def find_nearest_stop(lat: float, lng: float):
    ## find the stop closest to any given lat and lng. returns (stop, dist in meters)
    stops = get_stops()
    best_stop = None
    best_dist = float("inf")

    for s in stops:
        d = distance_m(lat, lng, s.latitude, s.longitude)
        if d < best_dist:
            best_dist = d 
            best_stop = s 
    return best_stop, best_dist

def match_stops(lat: float, lng:float, lat2: float, lng2: float):
    originstop, origindist = find_nearest_stop(lat, lng)
    deststop, destdist = find_nearest_stop(lat2, lng2)
    return {
        "origin": {
            "location": { "lat": lat, "lng": lng
            },
            "nearest_stop": stopdict(originstop),
            "distance_m": origindist,
        },
        "destination": {
            "location": { "lat": lat2, "lng": lng2 }, 
            "nearest_stop": stopdict(deststop),
            "distance_m": destdist,

            }



        }




@app.get("/stops")

def list_stops():
    stops = get_stops()
    return [stopdict(s) for s in stops]

@app.get("/vehicles")
def list_vehicles():
    vehicles = get_vehicles()
    return [vehicledict(v) for v in vehicles] 


@app.get("/nearest_stop")
def api_nearest_stop(lat: float, lng: float):
    ##given any lat and lng, return the closest shuttle stop and its dist in meters 
    stop, dist = find_nearest_stop(lat, lng)
    if not stop:
        return {"stop": None, "distance_m": None}
    return {
        "stop": stopdict(stop),
        "distance_m": dist, 
    }

@app.get("/match_stops")
def api_match_stops(lat: float, lng: float, lat2: float, lng2: float):
    return match_stops(lat, lng, lat2, lng2)



def find_common_routes(origin_stop, dest_stop):
    origin_routes = getattr(origin_stop, "routesAndPositions", {}) or {}
    dest_routes = getattr(dest_stop, "routesAndPositions", {}) or {}

    common_route_ids = set(origin_routes.keys()) & set(dest_routes.keys()) 

    all_routes = get_routes()
    routes_by_id = {r.myid: r for r in all_routes}
        
    result = []
    for rid in common_route_ids:
        route = routes_by_id.get(rid)
        if route:
            result.append({
                "route_id": route.myid,
                "route_name": route.name,
                "short_name": getattr(route, "shortName", None),
                "color": getattr(route, "groupColor", None),
            })
        else: 
            result.append({
                "route_id": rid,
                "route_name": None,
                "short_name": None, 
                "color": None, 
            })
    return result 
    






@app.get("/trip")
def api_trip(lat: float, lng: float, lat2: float, lng2: float):
    origin_stop, origin_dist = find_nearest_stop(lat, lng)
    dest_stop, dest_dist = find_nearest_stop(lat2, lng2)
    base = match_stops(lat, lng, lat2, lng2)
    routes = find_common_routes(origin_stop, dest_stop)
    base["routes"] = routes 
    return base 


