import { useState, useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import { SplashScreen } from "./components/SplashScreen";
import { Layout } from "./components/Layout";
import { SystemSelectModal } from "./components/SystemSelectModal";

interface System {
  id: number;
  name: string;
}

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [system, setSystem] = useState<System | null>(null);
  const [showSystemModal, setShowSystemModal] = useState(false);

  // Load system from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('system');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed?.id && parsed?.name) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSystem(parsed);
        }
      } catch (e) {
        console.error("Failed to parse stored system", e);
      }
    }
  }, []);

  const handleSplashDone = () => {
    setShowSplash(false);
    // If no system selected yet, show modal immediately after splash
    if (!system) {
      setShowSystemModal(true);
    }
  };

  const handleSystemSelected = (newSystem: System) => {
    setSystem(newSystem);
    localStorage.setItem('system', JSON.stringify(newSystem));
    setShowSystemModal(false);
  };

  return (
    <>
      <AnimatePresence>
        {showSplash && <SplashScreen onDone={handleSplashDone} />}
      </AnimatePresence>

      <Layout
        system={system}
        onChangeSystem={() => setShowSystemModal(true)}
      />

      <SystemSelectModal
        isOpen={showSystemModal}
        onSelect={handleSystemSelected}
      />
    </>
  );
}

export default App;
