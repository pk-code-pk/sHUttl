# vehicle_test.py

from passio_cilent import get_vehicles  # same helper you already wrote

def main():
    vehicles = get_vehicles()
    print("vehicles =", len(vehicles))
    if vehicles:
        v = vehicles[0]
        print("Raw vars(v):")
        print(vars(v))
    else:
        print("No active vehicles right now.")

if __name__ == "__main__":
    main()
