import { TelemetryEvent } from '@activepieces/shared';
import React, { useEffect } from 'react';

import { errorReporting } from '@/lib/error-reporting';

// Product telemetry is paused until an owned collection plan is approved.
// Keep the context contract without initializing an SDK or sending usage events.
const TelemetryProvider = ({ children }: { children: React.ReactNode }) => {
  useEffect(() => {
    errorReporting.init();
    errorReporting.flushBuffered();
  }, []);
  return (
    <TelemetryContext.Provider value={{ capture: () => {} }}>
      {children}
    </TelemetryContext.Provider>
  );
};
const TelemetryContext = React.createContext<{
  capture: (event: TelemetryEvent) => void;
}>({ capture: () => {} });
export const useTelemetry = () => React.useContext(TelemetryContext);
export default TelemetryProvider;
