# Stryd to Intervals.icu Workout Exporter

A lightweight Tampermonkey userscript that bridges **Stryd PowerCenter** and **Intervals.icu**.

It takes structured workouts directly from Stryd, automatically converts power percentages into **absolute Watts** based on your Critical Power (CP), and generates ready-to-paste [Intervals.icu](https://intervals.icu) workout builder syntax.

---

## How to Use It

1. **Install Tampermonkey**: Add the [Tampermonkey extension](https://www.tampermonkey.net/) to your browser. I tested Brave so far, but should work on Chrome and Firefox too.
2. **Add the Script**: Create a new userscript in your Tampermonkey dashboard and paste the contents of [`stryd_to_intervals.user.js`](https://github.com/Kurtpenter/stryd2intervals/raw/refs/heads/main/stryd_to_intervals.user.js).
3. **Open a Workout**: Navigate to [Stryd PowerCenter](https://www.stryd.com/powercenter/), open your training calendar and open a workout.
4. **Export in 1-Click**: Click the floating **Intervals.icu Preview** button in the bottom-right corner, check your workout, and click **Copy to Clipboard** to paste it straight into Intervals.icu.
5. **Import into Intervals.icu**: Go to [Intervals.icu](http://intervals.icu/) and paste into your next workout.

---

## Support

If you like this and it saves you time on your training days, buy me a good Italian espresso on https://ko-fi.com/kurtpenter ;)
