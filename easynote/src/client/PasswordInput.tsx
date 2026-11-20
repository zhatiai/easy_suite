import { useId, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { t } from './i18n';

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const generatedId = useId();
  const [visible, setVisible] = useState(false);
  const id = props.id ?? generatedId;
  const action = t(visible ? '隐藏密码' : '显示密码');
  return <span className="password-input">
    <input {...props} id={id} type={visible ? 'text' : 'password'} />
    <button type="button" className="password-toggle" aria-label={action} title={action}
      aria-controls={id} aria-pressed={visible} disabled={props.disabled}
      onClick={() => setVisible((current) => !current)}>
      {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
    </button>
  </span>;
}
