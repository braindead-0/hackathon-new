import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LOINC, VITAL_COLOR, type Metric } from "./api";
import type { Observation } from "./types";
import { clock } from "./ui";

const PANEL_METRICS: Metric[] = ["heart_rate", "spo2", "respiratory_rate", "temperature"];

const DIGITS: Record<string, number> = {
  heart_rate: 0,
  spo2: 1,
  respiratory_rate: 1,
  temperature: 2,
  systolic_bp: 0,
};

interface Point {
  t: number;
  value: number | null;
}

function toPoints(readings: Observation[], metric: Metric): Point[] {
  return readings.map((r) => {
    const raw = r[metric];
    const timestamp = r.timestamp.endsWith("Z") || /[+-]\d\d:\d\d$/.test(r.timestamp)
      ? r.timestamp
      : `${r.timestamp}Z`;
    return {
      t: new Date(timestamp).getTime(),
      value: raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw,
    };
  }).filter((point) => Number.isFinite(point.t)).sort((a, b) => a.t - b.t);
}

function VitalChart({
  metric,
  readings,
  baseline,
  untrusted,
  height = 150,
}: {
  metric: Metric;
  readings: Observation[];
  baseline?: { center: number; spread: number };
  untrusted: boolean;
  height?: number;
}) {
  const meta = LOINC[metric];
  const color = untrusted ? "#4b57a6" : (VITAL_COLOR[metric] ?? "#1d2b36");
  const data = toPoints(readings, metric);
  const present = data.filter((d) => d.value !== null);
  const digits = DIGITS[metric] ?? 1;
  const latest = present.length ? present[present.length - 1].value : null;

  const times = data.map((d) => d.t);
  const tMin = times.length ? Math.min(...times) : 0;
  const tMax = times.length ? Math.max(...times) : 0;
  const span = tMax - tMin;
  const single = span <= 0;
  const showSeconds = span < 5 * 60 * 1000;
  const gradId = `vgrad-${metric}`;

  return (
    <figure className="vchart">
      <figcaption className="vchart__head">
        <span className="vchart__name">
          <span className="vchart__dot" style={{ background: color }} aria-hidden />
          {meta.label}
          <span className="muted" style={{ fontWeight: 500 }}>
            {" "}
            ({meta.unit})
          </span>
        </span>
        <span className="vchart__latest" style={{ color }}>
          {latest === null ? "—" : latest.toFixed(digits)}
        </span>
      </figcaption>
      <div className="vchart__sub muted">
        {untrusted
          ? "latest signal untrusted"
          : baseline
            ? `baseline ${baseline.center.toFixed(digits)} ±${(3 * baseline.spread).toFixed(digits)}`
            : "baseline learning"}
      </div>
      {present.length === 0 ? (
        <div
          className="empty"
          style={{ height, display: "grid", placeItems: "center", padding: 0 }}
        >
          {readings.length === 0 ? "No readings available yet" : "No values reported in the available readings"}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -14 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#E3EAEE" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={single ? [tMin - 60000, tMax + 60000] : ["dataMin", "dataMax"]}
              ticks={single ? [tMin] : undefined}
              tickFormatter={(t) => clock(new Date(Number(t)).toISOString(), showSeconds)}
              tick={{ fontSize: 10, fill: "#5B6F7C" }}
              minTickGap={36}
              tickCount={4}
              axisLine={{ stroke: "#D5DEE3" }}
              tickLine={false}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fontSize: 10, fill: "#5B6F7C" }}
              width={46}
              tickFormatter={(v) => Number(v).toFixed(digits)}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              labelFormatter={(t) => `${clock(new Date(Number(t)).toISOString())} UTC`}
              formatter={(v) => [`${Number(v).toFixed(digits)} ${meta.unit}`, meta.label]}
              contentStyle={{ borderRadius: 8, border: "1px solid #d5dee3", fontSize: 12 }}
            />
            {baseline && (
              <ReferenceArea
                y1={baseline.center - 3 * baseline.spread}
                y2={baseline.center + 3 * baseline.spread}
                fill={color}
                fillOpacity={0.07}
                stroke="none"
                ifOverflow="extendDomain"
              />
            )}
            <Area
              dataKey="value"
              type="monotone"
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradId})`}
              connectNulls={false}
              isAnimationActive={false}
              dot={present.length === 1 ? { r: 3, fill: color, strokeWidth: 0 } : false}
              activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </figure>
  );
}

/**
 * Small multiples on a shared time axis. Seeing the vitals together is the
 * point: genuine deterioration moves several channels coherently, a sensor
 * fault moves one impossibly.
 */
export function VitalsCharts({
  readings,
  baselines,
  untrustedMetrics = [],
  includeBp = false,
}: {
  readings: Observation[];
  baselines: Record<string, { center: number; spread: number }>;
  untrustedMetrics?: string[];
  includeBp?: boolean;
}) {
  const metrics: Metric[] = includeBp ? [...PANEL_METRICS, "systolic_bp"] : PANEL_METRICS;
  return (
    <div className="grid grid--2">
      {metrics.map((metric) => (
        <VitalChart
          key={metric}
          metric={metric}
          readings={readings}
          baseline={baselines[metric]}
          untrusted={untrustedMetrics.includes(metric)}
        />
      ))}
    </div>
  );
}