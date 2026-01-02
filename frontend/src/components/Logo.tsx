import logo from "../assets/logo.svg";

export const Logo = ({ className }: { className?: string }) => {
    return (
        <img
            src={logo}
            alt="Harvard Shuttle"
            className={className}
            draggable={false}
        />
    );
};
