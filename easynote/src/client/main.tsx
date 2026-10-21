import { createRoot } from 'react-dom/client';
import App from './App';
import { installUiLanguage } from './i18n';
import 'katex/dist/katex.min.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
installUiLanguage();
