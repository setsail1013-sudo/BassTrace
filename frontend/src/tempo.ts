/**
 * Reinterpret a detected beat grid at another BPM without stretching the audio.
 * A ratio of 0.5 keeps every other beat; 2 inserts a beat between each pair.
 * The final interval continues far enough to cover the old grid's final beat.
 */
export function resampleBeatTimes(times: number[], ratio: number): number[] {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new RangeError('速度比例必须为正的有限数值');
  }
  if (times.length < 2 || times.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= times[index - 1]))) {
    throw new RangeError('逐拍网格必须包含至少两个严格递增的有限时间');
  }
  const last = times.length - 1;
  const finalInterval = times[last] - times[last - 1];
  const count = Math.max(2, Math.ceil(last * ratio) + 1);
  if (!Number.isSafeInteger(count)) throw new RangeError('速度比例产生的网格过长');
  return Array.from({ length: count }, (_, index) => {
    const oldIndex = index / ratio;
    if (oldIndex >= last) return times[last] + (oldIndex - last) * finalInterval;
    const lower = Math.floor(oldIndex);
    return times[lower] + (oldIndex - lower) * (times[lower + 1] - times[lower]);
  });
}
