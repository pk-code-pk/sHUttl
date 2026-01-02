## helper module to talk to passioGO API

import passiogo 
import os

DEFAULT_SYSTEM_ID = 831 
ENV_SYSTEM_ID = int(os.getenv("PASSIO_SYSTEM_ID", DEFAULT_SYSTEM_ID))
_systems = {} 


def get_system(system_id: int | None = None):
    ## creates and caches our TransportationSystem object  
    if system_id is None:
        system_id = ENV_SYSTEM_ID
    system = _systems.get(system_id)
    if system is None:
        system = passiogo.getSystemFromID(system_id)
        _systems[system_id] = system 
    return system 
## initialize system obj to harvard system 

##helper functions to get data specific to harvard shuttle 

def get_routes(system_id: int | None = None):
    system = get_system(system_id)
    return system.getRoutes()

def get_stops(system_id: int | None = None):
    system = get_system(system_id)
    return system.getStops()

def get_vehicles(system_id: int | None = None):
    system = get_system(system_id)
    return system.getVehicles() 

