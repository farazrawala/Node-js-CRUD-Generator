class RingBuffer {
  constructor(max) {
    this.max = max;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.max) this.items.shift();
    return item;
  }

  toArray() {
    return this.items.slice();
  }

  last(n) {
    return this.items.slice(-n);
  }

  get length() {
    return this.items.length;
  }
}

class RollingHistogram {
  constructor(buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10]) {
    this.bounds = buckets;
    this.reset();
  }

  reset() {
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    this.buckets = this.bounds.map(() => 0);
    this.inf = 0;
  }

  observe(seconds) {
    const value = Number(seconds) || 0;
    this.count += 1;
    this.sum += value;
    if (value > this.max) this.max = value;
    let placed = false;
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (value <= this.bounds[i]) {
        this.buckets[i] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) this.inf += 1;
  }

  percentile(p) {
    if (!this.count) return 0;
    const target = this.count * p;
    let cumulative = 0;
    for (let i = 0; i < this.bounds.length; i += 1) {
      cumulative += this.buckets[i];
      if (cumulative >= target) return this.bounds[i];
    }
    return this.bounds[this.bounds.length - 1];
  }

  avg() {
    return this.count ? this.sum / this.count : 0;
  }
}

class MultiResolutionSeries {
  constructor() {
    this.sec = new RingBuffer(15 * 60);
    this.fiveSec = new RingBuffer(12 * 60);
    this.minute = new RingBuffer(24 * 60);
    this._fiveBucket = [];
    this._minuteBucket = [];
    this._fiveTs = 0;
    this._minuteTs = 0;
  }

  push(point) {
    this.sec.push(point);
    this._fiveBucket.push(point);
    this._minuteBucket.push(point);
    if (!this._fiveTs) this._fiveTs = point.ts;
    if (!this._minuteTs) this._minuteTs = point.ts;
    if (point.ts - this._fiveTs >= 5000) {
      this.fiveSec.push(averagePoints(this._fiveBucket));
      this._fiveBucket = [];
      this._fiveTs = point.ts;
    }
    if (point.ts - this._minuteTs >= 60000) {
      this.minute.push(averagePoints(this._minuteBucket));
      this._minuteBucket = [];
      this._minuteTs = point.ts;
    }
  }

  forRange(range) {
    if (range === "1m") return this.sec.last(60);
    if (range === "5m") return this.sec.last(300);
    if (range === "15m") return this.sec.last(900);
    if (range === "1h") return this.fiveSec.last(720);
    if (range === "6h") return this.minute.last(360);
    if (range === "24h") return this.minute.last(1440);
    return this.sec.last(60);
  }
}

function averagePoints(points) {
  const n = points.length || 1;
  const out = { ts: points[points.length - 1].ts };
  const keys = Object.keys(points[0] || {}).filter((k) => k !== "ts");
  for (const key of keys) {
    out[key] = points.reduce((sum, p) => sum + (Number(p[key]) || 0), 0) / n;
  }
  return out;
}

module.exports = {
  RingBuffer,
  RollingHistogram,
  MultiResolutionSeries,
};
