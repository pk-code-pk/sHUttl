import { useState, useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import { SplashScreen } from "./components/SplashScreen";
import { Layout } from "./components/Layout";
import { SystemSelectModal } from "./components/SystemSelectModal";
import type { TripResponse } from "./components/types";
import { hasTripLink } from "./lib/tripLink";

interface System {
  id: number;
  name: string;
}

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [system, setSystem] = useState<System | null>(null);
  const [showSystemModal, setShowSystemModal] = useState(false);
  const [trip, setTrip] = useState<TripResponse | null>(null);

  // Harvard is the only system, so a first-time visitor arriving on a shared
  // trip link must not be stopped by the picker — the link would open to a
  // modal instead of the trip, which defeats the point of sharing it.
  const arrivedWithTripLink = hasTripLink(window.location.search);

  // Load system from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('system');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed?.id && parsed?.name) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSystem(parsed);
          return;
        }
      } catch (e) {
        console.error("Failed to parse stored system", e);
      }
    }
    if (arrivedWithTripLink) {
      setSystem({ id: 831, name: "Harvard Shuttles" });
    }
  }, [arrivedWithTripLink]);

  const handleSplashDone = () => {
    setShowSplash(false);
    // If no system selected yet, show modal immediately after splash — unless
    // the URL already names a trip, in which case go straight to it.
    if (!system && !arrivedWithTripLink) {
      setShowSystemModal(true);
    }
  };

  const handleSystemSelected = (newSystem: System) => {
    setSystem(newSystem);
    localStorage.setItem('system', JSON.stringify(newSystem));
    setShowSystemModal(false);
    setTrip(null); // Reset trip when system changes
  };

  return (
    <>
      <AnimatePresence>
        {showSplash && <SplashScreen onDone={handleSplashDone} />}
      </AnimatePresence>

      <Layout
        system={system}
        onChangeSystem={() => setShowSystemModal(true)}
        trip={trip}
        onTripChange={setTrip}
      />

      <SystemSelectModal
        isOpen={showSystemModal}
        onSelect={handleSystemSelected}
      />
    </>
  );
}

export default App;
