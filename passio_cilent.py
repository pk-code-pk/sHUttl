## helper module to talk to passioGO API

import passiogo 

HARVARD_SYSTEM_ID = 831 

_system = None 

def get_system():
    ## creates and caches our TransportationSystem object for Harvard specifically 
    global _system ## make it a global variable 
    if _system is None:
        _system = passiogo.getSystemFromID(HARVARD_SYSTEM_ID)
    return _system 
## initialize system obj to harvard system 

##helper functions to get data specific to harvard shuttle 

def get_routes():
    system = get_system()
    return system.getRoutes()

def get_stops():
    system = get_system()
    return system.getStops()

def get_vehicles():
    system = get_system()
    return system.getVehicles() 

