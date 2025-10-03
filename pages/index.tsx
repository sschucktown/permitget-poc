import { useState } from 'react';

export default function Home() {
  const [address, setAddress] = useState('');
  const [keyword, setKeyword] = useState('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const searchPermits = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/permits?address=${encodeURIComponent(address)}&keyword=${encodeURIComponent(keyword)}`);
      const data = await res.json();
      setResult(data);
    } catch (err) {
      console.error(err);
      setResult({ error: 'Search failed' });
    }
    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 600, margin: '50px auto', fontFamily: 'sans-serif' }}>
      <h1>PermitGet POC – South Carolina</h1>
      <input
        type="text"
        placeholder="Enter address"
        value={address}
        onChange={e => setAddress(e.target.value)}
        style={{ width: '100%', padding: '10px', marginBottom: '10px' }}
      />
      <input
        type="text"
        placeholder="Enter keyword (e.g. pool, roof, fence)"
        value={keyword}
        onChange={e => setKeyword(e.target.value)}
        style={{ width: '100%', padding: '10px', marginBottom: '10px' }}
      />
      <button onClick={searchPermits} disabled={loading} style={{ padding: '10px 20px' }}>
        {loading ? 'Searching…' : 'Search'}
      </button>

      {result && (
        <div style={{ marginTop: '20px' }}>
          <h2>Results</h2>
          {Array.isArray(result) && result.length > 0 ? (
            result.map((r, idx) => (
              <div key={idx} style={{ padding: '10px', border: '1px solid #ccc', marginBottom: '10px' }}>
                <p><b>Jurisdiction:</b> {r.jurisdiction}</p>
                <p><b>Permit Type:</b> {r.permit_type}</p>
                <p><b>Resource:</b> {r.is_pdf ? (
                  <a href={r.resource_url} target="_blank" rel="noreferrer">Download PDF</a>
                ) : (
                  <a href={r.resource_url} target="_blank" rel="noreferrer">Portal Link</a>
                )}</p>
              </div>
            ))
          ) : (
            <p>No results found.</p>
          )}
        </div>
      )}
    </div>
  );
}
