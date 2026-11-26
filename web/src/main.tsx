import { render } from 'preact';
import './styles/app.css';
import { App } from './App';
import { initTheme } from './lib/theme';

initTheme();

const root = document.getElementById('root');
if (root) {
  render(<App />, root);
}
