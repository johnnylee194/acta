import { registerRootComponent } from 'expo';
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import App from './src/App';
import { buildTodayTomorrowWidgetTree } from './src/widget/TodayTomorrowWidget';

registerWidgetTaskHandler(async (props) => {
  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED':
      props.renderWidget(buildTodayTomorrowWidgetTree());
      break;
    default:
      break;
  }
});

registerRootComponent(App);
