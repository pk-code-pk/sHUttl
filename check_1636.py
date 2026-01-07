
import asyncio
from main import get_routes, DEFAULT_SYSTEM_ID

def check_1636():
    routes = get_routes(DEFAULT_SYSTEM_ID)
    # Find 1636
    target = None
    for r in routes:
        name = r.name
        if "1636" in name:
            target = r
            break
            
    if not target:
        print("Route 1636 not found")
        return

    print(f"Found Route: {target.name} (ID: {target.myid})")
    stops = target.getStops()
    
    print("\nFull Stop Order with IDs:")
    for i, s in enumerate(stops):
        print(f"{i}. {s.name} (ID: {s.id})")

if __name__ == "__main__":
    check_1636()
