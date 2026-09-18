import { useState } from 'react';
import { Pivot } from '../components/Pivot';

export function PivotBuilder() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error && <div className="banner err">{error}</div>}
      <Pivot onError={setError} />
    </>
  );
}
