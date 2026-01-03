## helper module to talk to passioGO API

import passiogo 
import os
import logging
from fastapi import HTTPException

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_ID = 831 
ENV_SYSTEM_ID = int(os.getenv("PASSIO_SYSTEM_ID", DEFAULT_SYSTEM_ID))
_systems = {} 


def get_system(system_id: int | None = None):
    ## creates and caches our TransportationSystem object  
    if system_id is None:
        system_id = ENV_SYSTEM_ID
    
    try:
        system = _systems.get(system_id)
        if system is None:
            system = passiogo.getSystemFromID(system_id)
            if system:
                _systems[system_id] = system 
        return system
    except Exception as e:
        logger.exception("Failed to fetch system from Passio", extra={"system_id": system_id})
        raise HTTPException(
            status_code=503,
            detail="Upstream shuttle provider unavailable",
        )
## initialize system obj to harvard system 

##helper functions to get data specific to harvard shuttle 

def get_routes(system_id: int | None = None):
    try:
        system = get_system(system_id)
        return system.getRoutes()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to fetch routes from Passio", extra={"system_id": system_id})
        raise HTTPException(
            status_code=503,
            detail="Upstream shuttle provider unavailable",
        )

def get_stops(system_id: int | None = None):
    try:
        system = get_system(system_id)
        return system.getStops()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to fetch stops from Passio", extra={"system_id": system_id})
        raise HTTPException(
            status_code=503,
            detail="Upstream shuttle provider unavailable",
        )

def get_vehicles(system_id: int | None = None):
    try:
        system = get_system(system_id)
        return system.getVehicles() 
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to fetch vehicles from Passio", extra={"system_id": system_id})
        raise HTTPException(
            status_code=503,
            detail="Upstream shuttle provider unavailable",
        )

def get_all_systems():
    try:
        return passiogo.getSystems()
    except Exception as e:
        logger.exception("Failed to fetch all systems from Passio")
        raise HTTPException(
            status_code=503,
            detail="Upstream shuttle provider unavailable",
        )

