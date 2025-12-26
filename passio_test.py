import passiogo 

HARVARD_SYSTEM_ID = 831 
# hardcode harvard sys id 
def main():
    system = passiogo.getSystemFromID(HARVARD_SYSTEM_ID)
#create sys object for harvard 
    stops = system.getStops()
    routes = system.getRoutes()
    vehicles = system.getVehicles()
#call functions to get data about stops, routes, vehicles 
    print("Shuttle Data")
    print("stops = ", len(stops))
    print("routes = ", len(routes))
    print("vehicles = ", len(vehicles))
    print()

    if routes:
        print("for example:")
        print(vars(routes[0]))
        print()
    if stops:
        print("for example:")
        print(vars(stops[0]))
        print()
    if vehicles:
        print("for example:")
        print(vars(vehicles[0]))
        print()
    else:
        print("no active vehicles brotha")
#print data 
if __name__ == "__main__":
    main()
#ensure it runs as a solo script 

