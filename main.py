from fastapi import FastAPI
import math 
from passio_cilent import get_stops, get_vehicles 
app = FastAPI() 
#intialize our app with FastAPI framework 
@app.get("/health")
#test health of our api endpoint  
def health_check():
    return {"status": "ok", "message": "Backend is running!"}

def stopdict(stop):
#takes list of stops and turns it into json data 
    return{
        "id": stop.id, 
        "name": stop.name,
        "lat": stop.latitude,
        "lng": stop.longitude,
    }

def vehicledict(vehicle):
    lat = float(getattr(vehicle, "latitude", None)) if lat else None
    lng = float(getattr(vehicle, "longitude", None)) if lng else None
    return {
        "id": vehicle.id,
        "route_id": getattr(vehicle, "routeId", None),
        "route_name": getattr(vehicle, "routeName", None),
        "lat": lat,
        "lng": lng, 
        
    }



@app.get("/stops")

def list_stops():
    stops = get_stops()
    return [stopdict(s) for s in stops]

@app.get("/vehicles")
def list_vehicles():
    vehicles = get_vehicles()
    return [vehicledict(v) for v in vehicles] 