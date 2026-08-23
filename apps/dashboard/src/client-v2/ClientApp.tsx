import { DeskProvider, useDeskContext } from './DeskContext';
import { DeskScreen } from './views/DeskScreen';
import { LoginScreen } from './views/LoginScreen';

function ClientRoutes() {
  const d = useDeskContext();

  if (!d.token) {
    return (
      <LoginScreen
        accessCode={d.accessCode}
        setAccessCode={d.setAccessCode}
        loginError={d.loginError}
        busy={d.busy}
        onLogin={() => void d.login()}
      />
    );
  }

  return <DeskScreen />;
}

export function ClientApp() {
  return (
    <DeskProvider>
      <ClientRoutes />
    </DeskProvider>
  );
}
