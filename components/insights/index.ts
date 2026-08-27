// InsightsChat is the only member anything imports through the barrel; the other
// two are imported by path (InsightsSection -> InsightCard, the chart test ->
// InsightChart), so re-exporting them here just gave each component two names.
export { default as InsightsChat } from './InsightsChat';
